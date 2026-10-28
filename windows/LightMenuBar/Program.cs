using System;
using System.Windows.Forms;

namespace LightMCPMenuBar {
    static class Program {
        [STAThread]
        static void Main() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (System.Threading.SynchronizationContext.Current == null) {
                System.Threading.SynchronizationContext.SetSynchronizationContext(new System.Windows.Forms.WindowsFormsSynchronizationContext());
            }
            var hidden = new Form { ShowInTaskbar = false, WindowState = FormWindowState.Minimized };
            hidden.Load += (s, e) => hidden.Hide();
            var controller = new StatusController(hidden);
            controller.Launch();
            Application.Run(hidden);
        }
    }
}