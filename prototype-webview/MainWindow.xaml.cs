using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.VisualBasic.FileIO;
using Microsoft.Web.WebView2.Core;

namespace RpPetWebView
{
    public partial class MainWindow : Window
    {
        private const int WM_HOTKEY = 0x0312;
        private const int WM_NCHITTEST = 0x0084;
        private const int HTCLIENT = 1;
        private const int HTTRANSPARENT = -1;
        private const int HOTKEY_ID = 0x4A;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const int VK_LBUTTON = 0x01;

        /// <summary>拖拽喂食时，鲸鱼命中圆外再放宽的判定范围（DIP）。</summary>
        private const double FEED_MARGIN = 24;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        private sealed class HitCircle
        {
            public double X;
            public double Y;
            public double R;
        }

        private sealed class HitRect
        {
            public double X;
            public double Y;
            public double W;
            public double H;
        }

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT p);

        [DllImport("user32.dll")]
        private static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private readonly List<HitCircle> _circles = new List<HitCircle>();
        private readonly List<HitRect> _rects = new List<HitRect>();
        private readonly DispatcherTimer _cursorTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };

        private IntPtr _hwnd;
        private bool _webReady;
        /// <summary>页面按住鲸鱼期间，整个窗口都接收鼠标，拖拽不会因为移出命中圆而断掉。</summary>
        private bool _interactive;
        private DateTime _interactiveUntil = DateTime.MinValue;
        private POINT _lastCursor = new POINT { X = int.MinValue, Y = int.MinValue };
        private bool _lastInside;
        private bool _cursorSeen;
        private DateTime _cursorSentAt = DateTime.MinValue;
        private double _dpiX = 1.0;
        private double _dpiY = 1.0;

        private bool _feedHoverOn;
        private string _feedHoverName = "";
        private int _feedHoverCount;
        private double _feedHoverX;
        private double _feedHoverY;

        public MainWindow()
        {
            Diag.Log("window ctor begin");
            InitializeComponent();
            Diag.Log("xaml loaded");

            FillWorkArea();

            SourceInitialized += (_, _) => InitNative();
            Loaded += OnLoaded;
            Closed += OnClosed;
            Deactivated += (_, _) => PostWeb(new { type = "blur" });
            DpiChanged += (_, _) => UpdateDpi();
            DragEnter += OnDragEnterFeed;
            DragOver += OnDragOverFeed;
            DragLeave += OnDragLeaveFeed;
            Drop += OnDropFeed;
            _cursorTimer.Tick += CursorTick;
            _cursorTimer.Start();
        }

        private void FillWorkArea()
        {
            var area = SystemParameters.WorkArea;
            GetCursorPos(out var cursor);
            Log($"FillWorkArea: work=({area.Left},{area.Top},{area.Width},{area.Height}) cursor=({cursor.X},{cursor.Y}) screen=({SystemParameters.PrimaryScreenWidth}x{SystemParameters.PrimaryScreenHeight})");
            Left = area.Left;
            Top = area.Top;
            Width = area.Width;
            Height = area.Height;
        }

        private void InitNative()
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
            UpdateDpi();
            if (!RegisterHotKey(_hwnd, HOTKEY_ID, MOD_CONTROL | MOD_ALT, 0x4A))
            {
                Log("注册热键 Ctrl+Alt+J 失败（可能被其他程序占用）");
            }
        }

        private void UpdateDpi()
        {
            var dpi = VisualTreeHelper.GetDpi(this);
            _dpiX = dpi.DpiScaleX;
            _dpiY = dpi.DpiScaleY;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            FillWorkArea();
            Log($"OnLoaded: left={Left} top={Top} size={Width}x{Height} actual={ActualWidth}x{ActualHeight}");
            LocationChanged += (_, _) => Log($"location changed: {Left},{Top}");
            SizeChanged += (_, _) => Log($"size changed: {ActualWidth}x{ActualHeight}");

            try
            {
                var dataDir = Path.Combine(Path.GetTempPath(), "rp-pet-webview");
                Directory.CreateDirectory(dataDir);

                Web.DefaultBackgroundColor = System.Drawing.Color.Transparent;
                var env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                await Web.EnsureCoreWebView2Async(env);

                var core = Web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.WebMessageReceived += OnWebMessage;
                core.NavigationCompleted += (_, args) =>
                {
                    if (!args.IsSuccess)
                    {
                        Log($"导航失败: {args.WebErrorStatus} / {args.HttpStatusCode}");
                    }
                };
                core.SetVirtualHostNameToFolderMapping(
                    "pet.local",
                    Path.Combine(AppContext.BaseDirectory, "web"),
                    CoreWebView2HostResourceAccessKind.Allow);
                core.Navigate("https://pet.local/index.html");
                _webReady = true;
                Log("WebView2 就绪，加载 https://pet.local/index.html");
            }
            catch (Exception ex)
            {
                Log("WebView2 初始化失败: " + ex);
                MessageBox.Show("桌面宠物初始化失败：\n" + ex.Message, "瑾瑜", MessageBoxButton.OK, MessageBoxImage.Error);
                Close();
            }
        }

        private void OnClosed(object? sender, EventArgs e)
        {
            _cursorTimer.Stop();
            if (_hwnd != IntPtr.Zero)
            {
                UnregisterHotKey(_hwnd, HOTKEY_ID);
            }
            try
            {
                Web.Dispose();
            }
            catch
            {
                // 关闭阶段忽略
            }
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_HOTKEY)
            {
                if (wParam.ToInt32() == HOTKEY_ID)
                {
                    ToggleVisible();
                    handled = true;
                }
                return IntPtr.Zero;
            }

            if (msg == WM_NCHITTEST)
            {
                if (_interactive && DateTime.Now <= _interactiveUntil)
                {
                    handled = true;
                    return new IntPtr(HTCLIENT);
                }

                int sx = (short)(long)lParam;
                int sy = (short)((long)lParam >> 16);
                var p = new POINT { X = sx, Y = sy };
                ScreenToClient(hwnd, ref p);

                double x = p.X / _dpiX;
                double y = p.Y / _dpiY;
                bool inWindow = x >= 0 && y >= 0 && x <= ActualWidth && y <= ActualHeight;
                bool hit = inWindow && HitTest(x, y);

                handled = true;
                return new IntPtr(hit ? HTCLIENT : HTTRANSPARENT);
            }

            return IntPtr.Zero;
        }

        private bool HitTest(double x, double y)
        {
            foreach (var c in _circles)
            {
                double dx = x - c.X;
                double dy = y - c.Y;
                if (dx * dx + dy * dy <= c.R * c.R)
                {
                    return true;
                }
            }

            foreach (var r in _rects)
            {
                if (x >= r.X && x <= r.X + r.W && y >= r.Y && y <= r.Y + r.H)
                {
                    return true;
                }
            }

            return false;
        }

        private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json;
            try
            {
                json = e.WebMessageAsJson;
            }
            catch
            {
                return;
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                string type = root.TryGetProperty("type", out var t) ? (t.GetString() ?? "") : "";

                switch (type)
                {
                    case "hitmap":
                        ParseHitmap(root);
                        break;
                    case "interactive":
                    {
                        bool on = root.TryGetProperty("on", out var onEl) && onEl.ValueKind == JsonValueKind.True;
                        _interactive = on;
                        _interactiveUntil = on ? DateTime.Now.AddMilliseconds(1500) : DateTime.MinValue;
                        break;
                    }
                    case "focusInput":
                        FocusInput();
                        break;
                    case "hide":
                        HidePet();
                        break;
                    case "quit":
                        Close();
                        break;
                    case "copy":
                        CopyText(root);
                        break;
                    case "boot":
                        Log("页面启动完成");
                        break;
                    case "log":
                        Log("web: " + (root.TryGetProperty("text", out var text) ? text.GetString() : ""));
                        break;
                }
            }
            catch (Exception ex)
            {
                Log("页面消息处理失败: " + ex.Message + " / " + json);
            }
        }

        private void ParseHitmap(JsonElement root)
        {
            _circles.Clear();
            _rects.Clear();

            if (root.TryGetProperty("circles", out var circles) && circles.ValueKind == JsonValueKind.Array)
            {
                foreach (var c in circles.EnumerateArray())
                {
                    if (c.ValueKind != JsonValueKind.Object) continue;
                    _circles.Add(new HitCircle
                    {
                        X = c.GetProperty("x").GetDouble(),
                        Y = c.GetProperty("y").GetDouble(),
                        R = c.GetProperty("r").GetDouble()
                    });
                }
            }

            if (root.TryGetProperty("rects", out var rects) && rects.ValueKind == JsonValueKind.Array)
            {
                foreach (var r in rects.EnumerateArray())
                {
                    if (r.ValueKind != JsonValueKind.Object) continue;
                    _rects.Add(new HitRect
                    {
                        X = r.GetProperty("x").GetDouble(),
                        Y = r.GetProperty("y").GetDouble(),
                        W = r.GetProperty("w").GetDouble(),
                        H = r.GetProperty("h").GetDouble()
                    });
                }
            }
        }

        private void CopyText(JsonElement root)
        {
            try
            {
                if (root.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
                {
                    Clipboard.SetText(text.GetString() ?? "");
                }
            }
            catch (Exception ex)
            {
                Log("复制失败: " + ex.Message);
            }
        }

        private void CursorTick(object? sender, EventArgs e)
        {
            if (!_webReady || !IsVisible) return;
            if (_interactive && DateTime.Now > _interactiveUntil) _interactive = false;

            if (!GetCursorPos(out var cursor) || !GetWindowRect(_hwnd, out var rect)) return;

            bool inside = cursor.X >= rect.Left && cursor.X < rect.Right && cursor.Y >= rect.Top && cursor.Y < rect.Bottom;
            bool buttonDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            var now = DateTime.Now;
            bool moved = !_cursorSeen || cursor.X != _lastCursor.X || cursor.Y != _lastCursor.Y || inside != _lastInside;
            // 拖拽中每帧都上报，鲸鱼靠它跟手；其余时候静止则降低到每 500ms 一次
            if (!_interactive && !moved && (now - _cursorSentAt).TotalMilliseconds < 500) return;

            _cursorSeen = true;
            _lastCursor = cursor;
            _lastInside = inside;
            _cursorSentAt = now;

            var p = cursor;
            ScreenToClient(_hwnd, ref p);
            PostWeb(new
            {
                type = "cursor",
                x = Math.Round(p.X / _dpiX, 1),
                y = Math.Round(p.Y / _dpiY, 1),
                inside,
                down = buttonDown,
                screenX = cursor.X,
                screenY = cursor.Y
            });
        }

        private void FocusInput()
        {
            if (!IsVisible) ShowPet();
            Activate();
            SetForegroundWindow(_hwnd);
            Web.Focus();
        }

        private void ToggleVisible()
        {
            if (IsVisible)
            {
                HidePet();
            }
            else
            {
                ShowPet();
                PostWeb(new { type = "recall" });
            }
        }

        private void HidePet()
        {
            Hide();
            _lastCursor = new POINT { X = int.MinValue, Y = int.MinValue };
        }

        private void ShowPet()
        {
            Show();
            Topmost = true;
            Activate();
            SetForegroundWindow(_hwnd);
            Web.Focus();
        }

        /* ---------- 拖文件喂食 ---------- */

        private void OnDragEnterFeed(object sender, DragEventArgs e) => UpdateFeedHover(e);

        private void OnDragOverFeed(object sender, DragEventArgs e) => UpdateFeedHover(e);

        private void OnDragLeaveFeed(object sender, DragEventArgs e)
        {
            SetFeedHover(false, "", 0, 0, 0);
            e.Handled = true;
        }

        private bool TryGetDropPaths(DragEventArgs e, out string[] paths)
        {
            paths = Array.Empty<string>();
            if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return false;
            if (e.Data.GetData(DataFormats.FileDrop) is not string[] raw) return false;
            paths = raw.Where(p => !string.IsNullOrWhiteSpace(p) && (File.Exists(p) || Directory.Exists(p))).ToArray();
            return paths.Length > 0;
        }

        private bool FeedHitTest(Point point)
        {
            double x = point.X;
            double y = point.Y;
            double limit = FEED_MARGIN;

            foreach (var c in _circles)
            {
                double dx = x - c.X;
                double dy = y - c.Y;
                double r = c.R + limit;
                if (dx * dx + dy * dy <= r * r)
                {
                    return true;
                }
            }

            return false;
        }

        private void UpdateFeedHover(DragEventArgs e)
        {
            e.Handled = true;

            var point = e.GetPosition(this);
            if (!TryGetDropPaths(e, out var paths) || !FeedHitTest(point))
            {
                e.Effects = DragDropEffects.None;
                SetFeedHover(false, "", 0, point.X, point.Y);
                return;
            }

            e.Effects = FeedEffect(e);
            if (e.Effects == DragDropEffects.None) return;

            string name = paths.Length > 0 ? Path.GetFileName(paths[0]) : "";
            if (string.IsNullOrEmpty(name)) name = "这个图标";
            SetFeedHover(true, name, paths.Length, point.X, point.Y);
        }

        private static DragDropEffects FeedEffect(DragEventArgs e)
        {
            if ((e.AllowedEffects & DragDropEffects.Move) != 0) return DragDropEffects.Move;
            if ((e.AllowedEffects & DragDropEffects.Copy) != 0) return DragDropEffects.Copy;
            return DragDropEffects.None;
        }

        private void SetFeedHover(bool on, string name, int count, double x, double y)
        {
            bool same = _feedHoverOn == on && _feedHoverName == name && _feedHoverCount == count;
            if (same && (!on || (Math.Abs(x - _feedHoverX) < 3 && Math.Abs(y - _feedHoverY) < 3))) return;

            _feedHoverOn = on;
            _feedHoverName = name;
            _feedHoverCount = count;
            _feedHoverX = x;
            _feedHoverY = y;
            PostWeb(new
            {
                type = "feedHover",
                on,
                name,
                count,
                x = Math.Round(x, 1),
                y = Math.Round(y, 1)
            });
        }

        private async void OnDropFeed(object sender, DragEventArgs e)
        {
            e.Handled = true;
            SetFeedHover(false, "", 0, 0, 0);
            if (!TryGetDropPaths(e, out var paths))
            {
                e.Effects = DragDropEffects.None;
                return;
            }

            e.Effects = FeedEffect(e);
            if (e.Effects == DragDropEffects.None) return;
            var names = paths.Select(Path.GetFileName).ToArray();
            PostWeb(new { type = "feed", names, count = paths.Length });
            Log("喂食: " + string.Join(" | ", paths));

            Exception? failure = null;
            try
            {
                failure = await Task.Run(() => RecyclePaths(paths));
            }
            catch (Exception ex)
            {
                failure = ex;
            }

            if (failure == null)
            {
                PostWeb(new { type = "feedDone", ok = true, names, count = paths.Length });
                Log("已移入回收站: " + string.Join(" | ", paths));
            }
            else
            {
                PostWeb(new { type = "feedDone", ok = false, names, count = paths.Length, error = failure.Message });
                Log("喂食失败: " + failure.Message);
            }
        }

        /// <summary>把文件/文件夹移入回收站；碰系统目录、盘符根或用户目录本身时拒绝。</summary>
        private static Exception? RecyclePaths(string[] paths)
        {
            var errors = new List<string>();

            foreach (var path in paths)
            {
                try
                {
                    bool isDir = Directory.Exists(path);
                    bool isFile = File.Exists(path);
                    if (!isDir && !isFile)
                    {
                        errors.Add($"{Path.GetFileName(path)}：已经不在原处");
                        continue;
                    }

                    if (IsProtectedPath(path))
                    {
                        errors.Add($"{Path.GetFileName(path)}：这个不能吃");
                        continue;
                    }

                    if (isDir)
                    {
                        FileSystem.DeleteDirectory(
                            path,
                            UIOption.OnlyErrorDialogs,
                            RecycleOption.SendToRecycleBin,
                            UICancelOption.DoNothing);
                    }
                    else
                    {
                        FileSystem.DeleteFile(
                            path,
                            UIOption.OnlyErrorDialogs,
                            RecycleOption.SendToRecycleBin,
                            UICancelOption.DoNothing);
                    }
                }
                catch (Exception ex)
                {
                    errors.Add($"{Path.GetFileName(path)}：{ex.Message}");
                }
            }

            return errors.Count == 0 ? null : new Exception(string.Join("；", errors));
        }

        private static bool IsProtectedPath(string path)
        {
            try
            {
                string full = Path.GetFullPath(path).TrimEnd('\\');
                string root = (Path.GetPathRoot(full) ?? "").TrimEnd('\\');
                if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return true;

                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop).TrimEnd('\\');
                string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
                string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\');

                if (string.Equals(full, desktop, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(full, profile, StringComparison.OrdinalIgnoreCase)) return true;
                if (windows.Length > 0 && full.StartsWith(windows + "\\", StringComparison.OrdinalIgnoreCase)) return true;

                return false;
            }
            catch
            {
                return true;
            }
        }

        private void PostWeb(object payload)
        {
            if (!_webReady) return;
            try
            {
                Web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
            }
            catch (Exception ex)
            {
                Log("发送消息失败: " + ex.Message);
            }
        }

        private static void Log(string text)
        {
            try
            {
                var dir = Path.Combine(Path.GetTempPath(), "rp-pet-webview");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "host.log"), $"{DateTime.Now:HH:mm:ss.fff} {text}{Environment.NewLine}");
            }
            catch
            {
                // 日志失败不影响运行
            }
        }
    }
}
