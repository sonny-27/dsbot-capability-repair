using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;
using System.Threading;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
internal static class Launcher {
    [STAThread]
    private static void Main(string[] args) {
        try {
            string root=AppDomain.CurrentDomain.BaseDirectory;
            if(args.Length==2 && args[0]=="--preview")Environment.SetEnvironmentVariable("DSBOT_REPAIR_PREVIEW",args[1]);
            string script=Path.Combine(root,"DSBot-Repair.ps1");
            if(!File.Exists(script)) throw new FileNotFoundException("请先完整解压修复工具目录。",script);
            var initial=InitialSessionState.CreateDefault();
            initial.ExecutionPolicy=Microsoft.PowerShell.ExecutionPolicy.Bypass;
            using(var runspace=RunspaceFactory.CreateRunspace(initial)) {
                runspace.ApartmentState=ApartmentState.STA;
                runspace.ThreadOptions=PSThreadOptions.UseCurrentThread;
                runspace.Open();
                using(var ps=PowerShell.Create()) {
                    ps.Runspace=runspace; ps.AddCommand(script); ps.Invoke();
                    if(ps.HadErrors)throw new Exception(ps.Streams.Error[0].ToString());
                }
            }
        } catch(Exception e) { MessageBox.Show(e.Message,"DS Bot 修复工具",MessageBoxButtons.OK,MessageBoxIcon.Error); }
    }
}
