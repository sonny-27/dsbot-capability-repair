using System;
using System.Text;
using System.Diagnostics;
using System.Collections.Concurrent;
public sealed class DSBotRepairRunner {
    public Process Process;
    public ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    public static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes=0;
        foreach (char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); slashes=0; continue; }
            b.Append('\\',slashes); b.Append(c); slashes=0;
        }
        b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
    }
    public void Start(string exe, string[] args, string cwd) {
        var quoted = new string[args.Length];
        for(int i=0;i<args.Length;i++) quoted[i]=Quote(args[i]);
        var info = new ProcessStartInfo(exe, String.Join(" ",quoted));
        info.WorkingDirectory=cwd; info.UseShellExecute=false; info.CreateNoWindow=true;
        info.RedirectStandardOutput=true; info.RedirectStandardError=true;
        info.StandardOutputEncoding=Encoding.UTF8; info.StandardErrorEncoding=Encoding.UTF8;
        info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";
        info.EnvironmentVariables.Remove("NODE_OPTIONS");
        Process=new Process(); Process.StartInfo=info;
        Process.OutputDataReceived+=(s,e)=>{if(e.Data!=null) Lines.Enqueue(e.Data);};
        Process.ErrorDataReceived+=(s,e)=>{if(e.Data!=null) Lines.Enqueue(e.Data);};
        Process.Start(); Process.BeginOutputReadLine(); Process.BeginErrorReadLine();
    }
}