using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using WinForms = System.Windows.Forms;

namespace PetPrototype
{
    public partial class MainWindow : Window
    {
        private const int WM_HOTKEY = 0x0312;
        private const int WM_NCHITTEST = 0x0084;
        private const int HTTRANSPARENT = -1;
        private const int HOTKEY_ID = 0x4A; // J
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private static readonly Dictionary<string, string> Mouths = new Dictionary<string, string>
        {
            { "neutral", "M134,94 Q142,99 150,94" },
            { "happy", "M132,90 Q142,102 152,90" },
            { "shy", "M136,93 Q142,98 148,93" },
            { "sad", "M134,98 Q142,91 150,98" },
            { "sleepy", "M136,96 Q142,96 148,96" },
            { "curious", "M134,94 Q142,99 150,94" },
            { "angry", "M133,97 Q142,92 151,97" },
            { "worried", "M134,97 Q142,93 150,97" }
        };

        private IntPtr _hwnd;
        private HwndSource _source;

        private bool _quiet;
        private bool _sleeping;
        private bool _dragging;
        private bool _moved;
        private bool _hoverBubble;
        private bool _playing;
        private bool _altPalette;

        private DateTime _lastActivity = DateTime.Now;
        private DateTime _pinnedUntil = DateTime.MinValue;
        private string _currentText = "";

        private Point _dragStartCursor;
        private Point _dragStartWindow;

        private readonly List<QueuedMsg> _queue = new List<QueuedMsg>();

        private ScaleTransform _squash;
        private RotateTransform _rot;
        private TranslateTransform _nod;
        private TranslateTransform _bob;

        private DispatcherTimer _pointerTimer;
        private DispatcherTimer _blinkTimer;
        private DispatcherTimer _sleepTimer;
        private DispatcherTimer _toastTimer;

        private sealed class BubbleItem
        {
            public string Text;
            public string Emotion;
            public int DelayMs;
        }

        private sealed class QueuedMsg
        {
            public List<BubbleItem> Bubbles;
            public string[] Actions;
            public int Priority;
        }

        public MainWindow()
        {
            InitializeComponent();

            SourceInitialized += OnSourceInitialized;
            Closed += OnClosed;
            Loaded += OnLoaded;

            SetupWhaleTransforms();
            WireEvents();
        }

        // ---------- 初始化 ----------

        private void SetupWhaleTransforms()
        {
            _squash = new ScaleTransform(1, 1);
            _rot = new RotateTransform(0);
            _nod = new TranslateTransform(0, 0);
            _bob = new TranslateTransform(0, 0);

            var group = new TransformGroup();
            group.Children.Add(_squash);
            group.Children.Add(_rot);
            group.Children.Add(_nod);
            group.Children.Add(_bob);
            Whale.RenderTransform = group;

            var bob = new DoubleAnimation(0, -7, TimeSpan.FromSeconds(1.6))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            _bob.BeginAnimation(TranslateTransform.YProperty, bob);
        }

        private void WireEvents()
        {
            Whale.MouseLeftButtonDown += Whale_MouseLeftButtonDown;
            Whale.MouseMove += Whale_MouseMove;
            Whale.MouseLeftButtonUp += Whale_MouseLeftButtonUp;

            Hint.MouseLeftButtonDown += (s, e) =>
            {
                Touch();
                OpenCapsule();
                e.Handled = true;
            };

            BubbleStack.MouseEnter += (s, e) => _hoverBubble = true;
            BubbleStack.MouseLeave += (s, e) => _hoverBubble = false;
            BubbleStack.MouseLeftButtonDown += (s, e) =>
            {
                _pinnedUntil = _pinnedUntil > DateTime.Now ? DateTime.MinValue : DateTime.Now.AddSeconds(30);
                e.Handled = true;
            };
            BubbleStack.MouseRightButtonDown += (s, e) =>
            {
                try
                {
                    Clipboard.SetText(_currentText);
                    Toast("已复制");
                }
                catch
                {
                    // 剪贴板被占用时忽略
                }
                e.Handled = true;
            };

            Input.KeyDown += Input_KeyDown;
            Input.TextChanged += (s, e) =>
            {
                Placeholder.Visibility = string.IsNullOrEmpty(Input.Text) ? Visibility.Visible : Visibility.Collapsed;
            };

            SendButton.Click += (s, e) => SendText();
            MicButton.Click += (s, e) => Toast("语音输入在原型里还没接");

            Deactivated += (s, e) =>
            {
                if (Capsule.Visibility == Visibility.Visible) CloseCapsule();
            };
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            var area = SystemParameters.WorkArea;
            Left = area.Right - Width - 24;
            Top = area.Bottom - Height - 24;

            SetEmotion("neutral");

            _pointerTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(50), DispatcherPriority.Background, (s, e2) => UpdatePointer(), Dispatcher);
            _pointerTimer.Start();

            _blinkTimer = new DispatcherTimer(TimeSpan.FromSeconds(4.2), DispatcherPriority.Background, (s, e2) => Blink(), Dispatcher);
            _blinkTimer.Start();

            _sleepTimer = new DispatcherTimer(TimeSpan.FromSeconds(10), DispatcherPriority.Background, (s, e2) => CheckSleep(), Dispatcher);
            _sleepTimer.Start();

            UpdatePointer();

            await Task.Delay(1200);
            Enqueue(Greeting());
        }

        private void OnSourceInitialized(object sender, EventArgs e)
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            _source = HwndSource.FromHwnd(_hwnd);
            _source?.AddHook(WndProc);
            RegisterHotKey(_hwnd, HOTKEY_ID, MOD_CONTROL | MOD_ALT, 0x4A);
        }

        private void OnClosed(object sender, EventArgs e)
        {
            if (_hwnd != IntPtr.Zero) UnregisterHotKey(_hwnd, HOTKEY_ID);
            _source?.RemoveHook(WndProc);

            _pointerTimer?.Stop();
            _blinkTimer?.Stop();
            _sleepTimer?.Stop();
            _toastTimer?.Stop();
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_HOTKEY && wParam.ToInt32() == HOTKEY_ID)
            {
                Show();
                Activate();
                if (Capsule.Visibility == Visibility.Visible) CloseCapsule();
                else OpenCapsule();
                handled = true;
            }

            if (msg == WM_NCHITTEST)
            {
                int value = lParam.ToInt32();
                int x = (short)(value & 0xFFFF);
                int y = (short)((value >> 16) & 0xFFFF);

                if (!IsInteractiveAt(x, y))
                {
                    handled = true;
                    return new IntPtr(HTTRANSPARENT);
                }
            }

            return IntPtr.Zero;
        }

        // ---------- 穿透命中 ----------

        private void UpdatePointer()
        {
            if (!_dragging) Gaze(WinForms.Cursor.Position);
        }

        private bool IsInteractiveAt(int screenX, int screenY)
        {
            try
            {
                return Whale.IsMouseCaptured
                       || HitTest(Whale, screenX, screenY)
                       || HitTest(Hint, screenX, screenY)
                       || HitTest(BubbleStack, screenX, screenY)
                       || Capsule.Visibility == Visibility.Visible && HitTest(Capsule, screenX, screenY);
            }
            catch
            {
                return true;
            }
        }

        private static bool HitTest(FrameworkElement element, int screenX, int screenY)
        {
            if (element == null || element.Visibility != Visibility.Visible) return false;

            var p = element.PointFromScreen(new Point(screenX, screenY));
            return p.X >= 0 && p.Y >= 0 && p.X <= element.ActualWidth && p.Y <= element.ActualHeight;
        }

        private void Gaze(System.Drawing.Point cursor)
        {
            try
            {
                var p = Eye.PointFromScreen(new Point(cursor.X, cursor.Y));
                double dx = p.X - 10;
                double dy = p.Y - 9;
                double len = Math.Max(1, Math.Sqrt(dx * dx + dy * dy));
                double k = Math.Min(1, len / 220);
                PupilShift.X = dx / len * 3 * k;
                PupilShift.Y = dy / len * 2.4 * k;
            }
            catch
            {
                // 窗口未显示时忽略
            }
        }

        // ---------- 表情与动作 ----------

        private void SetEmotion(string name)
        {
            string key = Mouths.ContainsKey(name) ? name : "neutral";
            MouthPath.Data = Geometry.Parse(Mouths[key]);
            BlushEllipse.Opacity = key == "shy" ? 0.8 : 0.55;
        }

        private static DoubleAnimationUsingKeyFrames Keyframes(params (double value, double seconds)[] frames)
        {
            var animation = new DoubleAnimationUsingKeyFrames();
            foreach (var frame in frames)
            {
                animation.KeyFrames.Add(new LinearDoubleKeyFrame(frame.value, KeyTime.FromTimeSpan(TimeSpan.FromSeconds(frame.seconds))));
            }
            return animation;
        }

        private void PlayAction(string name)
        {
            switch (name)
            {
                case "wave":
                    _rot.BeginAnimation(RotateTransform.AngleProperty, Keyframes((0, 0), (-7, 0.15), (7, 0.3), (0, 0.5)));
                    break;
                case "nod":
                    _nod.BeginAnimation(TranslateTransform.YProperty, Keyframes((0, 0), (6, 0.15), (0, 0.3), (6, 0.45), (0, 0.6)));
                    break;
                case "shake":
                    _rot.BeginAnimation(RotateTransform.AngleProperty, Keyframes((0, 0), (-4, 0.1), (4, 0.2), (-4, 0.3), (0, 0.45)));
                    break;
                case "eat":
                    _squash.BeginAnimation(ScaleTransform.ScaleYProperty, Keyframes((1, 0), (0.93, 0.12), (1, 0.24), (0.93, 0.36), (1, 0.5)));
                    break;
                case "celebrate":
                    _nod.BeginAnimation(TranslateTransform.YProperty, Keyframes((0, 0), (-9, 0.15), (0, 0.3), (-9, 0.45), (0, 0.6)));
                    break;
                case "peek":
                    _rot.BeginAnimation(RotateTransform.AngleProperty, Keyframes((0, 0), (-5, 0.2), (0, 0.7)));
                    break;
                case "hide":
                case "squash":
                case "headpat":
                default:
                    _squash.BeginAnimation(ScaleTransform.ScaleYProperty, Keyframes((1, 0), (0.9, 0.15), (1, 0.4)));
                    _squash.BeginAnimation(ScaleTransform.ScaleXProperty, Keyframes((1, 0), (1.06, 0.15), (1, 0.4)));
                    break;
            }
        }

        // ---------- 睡眠与眨眼 ----------

        private void Blink()
        {
            if (_sleeping) return;
            if (Random.Shared.NextDouble() < 0.7)
            {
                EyeScale.BeginAnimation(ScaleTransform.ScaleYProperty, Keyframes((1, 0), (0.12, 0.06), (1, 0.15)));
            }
        }

        private void CheckSleep()
        {
            if (_sleeping || (DateTime.Now - _lastActivity).TotalMinutes < 5) return;
            _sleeping = true;
            SetEmotion("sleepy");
            EyeScale.BeginAnimation(ScaleTransform.ScaleYProperty, Keyframes((1, 0), (0.15, 0.25)));
        }

        private void Wake()
        {
            if (!_sleeping) return;
            _sleeping = false;
            SetEmotion("neutral");
            EyeScale.BeginAnimation(ScaleTransform.ScaleYProperty, Keyframes((1, 0), (1, 0.2)));
        }

        private void Touch()
        {
            _lastActivity = DateTime.Now;
            Wake();
        }

        // ---------- 气泡 ----------

        private void Enqueue(QueuedMsg message)
        {
            if (message?.Bubbles == null || message.Bubbles.Count == 0) return;

            if (message.Priority >= 3) _queue.Insert(0, message);
            else _queue.Add(message);

            if (!_playing) _ = RunQueueAsync();
        }

        private async Task RunQueueAsync()
        {
            _playing = true;
            try
            {
                while (_queue.Count > 0)
                {
                    var message = _queue[0];
                    _queue.RemoveAt(0);

                    if (_quiet && message.Priority < 3) continue;

                    Touch();
                    if (message.Actions != null && message.Actions.Length > 0) PlayAction(message.Actions[0]);

                    for (int i = 0; i < message.Bubbles.Count; i++)
                    {
                        if (_quiet && message.Priority < 3) break;
                        if (i > 0 && message.Bubbles[i].DelayMs > 0) await Task.Delay(message.Bubbles[i].DelayMs);
                        await ShowBubbleAsync(message.Bubbles[i].Text, message.Bubbles[i].Emotion);
                    }
                }
            }
            finally
            {
                _playing = false;
            }
        }

        private async Task ShowBubbleAsync(string text, string emotion)
        {
            _currentText = text;
            BubbleText.Text = "";
            BubbleStack.Visibility = Visibility.Visible;
            Touch();
            SetEmotion(emotion);

            double per = Math.Min(25.0, 1200.0 / Math.Max(1, text.Length));
            for (int i = 0; i < text.Length; i++)
            {
                await Task.Delay(Math.Max(8, (int)per));
                if (i > 60)
                {
                    BubbleText.Text = text;
                    break;
                }
                BubbleText.Text = text.Substring(0, i + 1);
            }
            BubbleText.Text = text;

            double remain = Math.Max(5000, Math.Min(12000, 4000 + text.Length * 50));
            while (remain > 0)
            {
                await Task.Delay(100);
                bool paused = _hoverBubble || DateTime.Now < _pinnedUntil;
                if (!paused) remain -= 100;
            }

            BubbleStack.Visibility = Visibility.Collapsed;
            _pinnedUntil = DateTime.MinValue;
        }

        private void Toast(string text)
        {
            ToastText.Text = text;
            ToastBorder.Visibility = Visibility.Visible;

            _toastTimer?.Stop();
            _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1600) };
            _toastTimer.Tick += (s, e) =>
            {
                ToastBorder.Visibility = Visibility.Collapsed;
                _toastTimer.Stop();
            };
            _toastTimer.Start();
        }

        private void Think(bool on)
        {
            Dots.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
            if (on)
            {
                var animation = new DoubleAnimation(0.35, 1, TimeSpan.FromSeconds(0.6))
                {
                    AutoReverse = true,
                    RepeatBehavior = RepeatBehavior.Forever
                };
                Dots.BeginAnimation(OpacityProperty, animation);
            }
            else
            {
                Dots.BeginAnimation(OpacityProperty, null);
            }

            if (!_sleeping) SetEmotion(on ? "curious" : "neutral");
        }

        // ---------- 输入胶囊 ----------

        private void OpenCapsule()
        {
            Touch();
            BubbleStack.Visibility = Visibility.Collapsed;
            Capsule.Visibility = Visibility.Visible;

            Activate();
            Dispatcher.BeginInvoke(new Action(() =>
            {
                Input.Focus();
                Keyboard.Focus(Input);
            }), DispatcherPriority.Input);

            SetEmotion("curious");
        }

        private void CloseCapsule()
        {
            Capsule.Visibility = Visibility.Collapsed;
            if (!_sleeping) SetEmotion("neutral");
            UpdatePointer();
        }

        private void Input_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Escape)
            {
                CloseCapsule();
                e.Handled = true;
                return;
            }

            if (e.Key == Key.Enter && !Keyboard.Modifiers.HasFlag(ModifierKeys.Shift))
            {
                SendText();
                e.Handled = true;
            }
        }

        private async void SendText()
        {
            string text = Input.Text.Trim();
            if (text.Length == 0) return;

            Input.Text = "";
            CloseCapsule();
            Think(true);

            await Task.Delay(1200 + Random.Shared.Next(600));
            Think(false);

            Enqueue(ReplyFor(text));
        }

        private QueuedMsg ReplyFor(string text)
        {
            if (Regex.IsMatch(text, "累|加班|忙"))
            {
                return MakeMsg("那就先歇一会儿吧，我在这儿。", "shy", "headpat");
            }
            if (Regex.IsMatch(text, "晚安|睡|困"))
            {
                return MakeMsg("晚安，做个好梦。", "sleepy", "nod");
            }
            if (Regex.IsMatch(text, "你好|在吗|在不在"))
            {
                return new QueuedMsg
                {
                    Priority = 1,
                    Actions = new[] { "wave" },
                    Bubbles = new List<BubbleItem>
                    {
                        new BubbleItem { Text = "在呢。", Emotion = "happy" },
                        new BubbleItem { Text = "你今天来得比平时晚一点。", Emotion = "shy", DelayMs = 900 }
                    }
                };
            }
            if (Regex.IsMatch(text, "吃|饿"))
            {
                return MakeMsg("我也想吃。", "happy", "eat");
            }

            var lines = new[]
            {
                MakeMsg("唔，我记下了。", "neutral", "nod"),
                MakeMsg("你这么说，我就当真了。", "shy", "nod"),
                MakeMsg("再讲一点？", "curious", "peek")
            };
            return lines[Random.Shared.Next(lines.Length)];
        }

        private static QueuedMsg MakeMsg(string text, string emotion, string action)
        {
            return new QueuedMsg
            {
                Priority = 1,
                Actions = new[] { action },
                Bubbles = new List<BubbleItem> { new BubbleItem { Text = text, Emotion = emotion } }
            };
        }

        private static QueuedMsg Greeting()
        {
            return new QueuedMsg
            {
                Priority = 0,
                Actions = new[] { "wave" },
                Bubbles = new List<BubbleItem>
                {
                    new BubbleItem { Text = "你回来啦。", Emotion = "happy" },
                    new BubbleItem { Text = "今天……还好吗？", Emotion = "shy", DelayMs = 900 }
                }
            };
        }

        // ---------- 戳、拖拽 ----------

        private async void Poke()
        {
            Touch();
            PlayAction("squash");

            await Task.Delay(450);
            if (_quiet) return;
            if (Random.Shared.NextDouble() >= 0.6) return;

            string[] lines = { "唔…你戳我。", "在呢，别闹。", "再戳就要生气了。" };
            Enqueue(new QueuedMsg
            {
                Priority = 1,
                Actions = new[] { "shake" },
                Bubbles = new List<BubbleItem>
                {
                    new BubbleItem { Text = lines[Random.Shared.Next(lines.Length)], Emotion = "shy" }
                }
            });
        }

        private void Whale_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (e.ChangedButton != MouseButton.Left) return;

            Touch();

            if (e.ClickCount == 2)
            {
                Poke();
                OpenCapsule();
                e.Handled = true;
                return;
            }

            var cursor = WinForms.Cursor.Position;
            _dragStartCursor = new Point(cursor.X, cursor.Y);
            _dragStartWindow = new Point(Left, Top);
            _moved = false;
            _dragging = false;

            Whale.CaptureMouse();
            e.Handled = true;
        }

        private void Whale_MouseMove(object sender, MouseEventArgs e)
        {
            if (!Whale.IsMouseCaptured || e.LeftButton != MouseButtonState.Pressed) return;

            var cursor = WinForms.Cursor.Position;
            double dx = cursor.X - _dragStartCursor.X;
            double dy = cursor.Y - _dragStartCursor.Y;

            if (!_moved && Math.Abs(dx) + Math.Abs(dy) > 5)
            {
                _moved = true;
                _dragging = true;
            }
            if (!_moved) return;

            var dip = DeviceToDip(new Vector(dx, dy));
            double areaLeft = SystemParameters.VirtualScreenLeft;
            double areaTop = SystemParameters.VirtualScreenTop;
            double areaRight = areaLeft + SystemParameters.VirtualScreenWidth;
            double areaBottom = areaTop + SystemParameters.VirtualScreenHeight;

            Left = Math.Max(areaLeft, Math.Min(_dragStartWindow.X + dip.X, areaRight - Width));
            Top = Math.Max(areaTop, Math.Min(_dragStartWindow.Y + dip.Y, areaBottom - Height));
        }

        private void Whale_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
        {
            if (!Whale.IsMouseCaptured) return;

            Whale.ReleaseMouseCapture();
            bool wasMoved = _moved;
            _moved = false;
            _dragging = false;

            if (wasMoved) PlayAction("squash");
            else Poke();

            UpdatePointer();
            e.Handled = true;
        }

        private Vector DeviceToDip(Vector device)
        {
            var source = PresentationSource.FromVisual(this);
            if (source?.CompositionTarget == null) return device;

            var m = source.CompositionTarget.TransformFromDevice;
            return new Vector(m.M11 * device.X, m.M22 * device.Y);
        }

        // ---------- 右键菜单 ----------

        private void MenuPalette_Click(object sender, RoutedEventArgs e)
        {
            _altPalette = !_altPalette;
            ApplyPalette(_altPalette);
            Toast("已换配色");
        }

        private void ApplyPalette(bool alt)
        {
            Color body = alt ? Color.FromRgb(0xF5, 0xC6, 0xA5) : Color.FromRgb(0x8F, 0xD3, 0xE8);
            Color fin = alt ? Color.FromRgb(0xE0, 0xA7, 0x83) : Color.FromRgb(0x6F, 0xB7, 0xC9);
            Color belly = alt ? Color.FromRgb(0xFF, 0xF3, 0xE9) : Color.FromRgb(0xEA, 0xF7, 0xFB);

            BodyEllipse.Fill = new SolidColorBrush(body);
            TailPath.Fill = new SolidColorBrush(fin);
            FlipperPath.Fill = new SolidColorBrush(fin);
            SpoutPath.Stroke = new SolidColorBrush(fin);
            BellyEllipse.Fill = new SolidColorBrush(belly);
        }

        private void MenuQuiet_Click(object sender, RoutedEventArgs e)
        {
            _quiet = !_quiet;
            QuietItem.Header = _quiet ? "取消勿扰" : "静音 / 勿扰";
            Toast(_quiet ? "已进入勿扰" : "已恢复");
        }

        private void MenuHide_Click(object sender, RoutedEventArgs e)
        {
            Hide();
        }

        private void MenuQuit_Click(object sender, RoutedEventArgs e)
        {
            Close();
        }
    }
}
