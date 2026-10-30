using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LightMCPMenuBar {
    static class Program {
        [STAThread]
        static void Main() {
            // Before any window: the icon is then drawn at the real small icon size (crisp at 125 %, 150 %…).
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // One copy per Windows session: a second one would start a second server on the same port.
            bool first;
            using (new Mutex(true, @"Local\LightMCPMenuBar", out first)) {
                if (!first) {
                    MessageBox.Show("Light MCP est déjà lancé : son icône est dans la zone de notification.", "Light MCP", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (s, e) => LogFile.AppendLine("[menubar] unexpected error: " + e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (s, e) => LogFile.AppendLine("[menubar] fatal error: " + e.ExceptionObject);
                // The supervisor, the health monitor and the builder post their callbacks to this thread.
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

                using (var controller = new StatusController()) {
                    // Closing the Windows session stops the server cleanly too, as quitting the app does.
                    SessionEndedEventHandler sessionEnded = (s, e) => controller.Shutdown();
                    SystemEvents.SessionEnded += sessionEnded;
                    controller.Launch();
                    Application.Run();
                    SystemEvents.SessionEnded -= sessionEnded;
                    controller.Shutdown();
                }
            }
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
    }
}
