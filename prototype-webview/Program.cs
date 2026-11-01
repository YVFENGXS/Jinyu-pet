using System;
using System.IO;
using System.Windows;

namespace RpPetWebView
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Diag.Log("main start");

            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                Diag.Log("domain exception: " + e.ExceptionObject);

            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            app.DispatcherUnhandledException += (_, e) =>
                Diag.Log("dispatcher exception: " + e.Exception);

            try
            {
                var window = new MainWindow();
                app.Run(window);
                Diag.Log("main exit");
            }
            catch (Exception ex)
            {
                Diag.Log("main exception: " + ex);
                throw;
            }
        }
    }

    internal static class Diag
    {
        internal static void Log(string text)
        {
            try
            {
                var dir = Path.Combine(Path.GetTempPath(), "rp-pet-webview");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "host.log"), $"{DateTime.Now:HH:mm:ss.fff} {text}{Environment.NewLine}");
            }
            catch
            {
                // 诊断日志失败不影响运行
            }
        }
    }
}
