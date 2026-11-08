param([string]$AppDir, [string]$DataHome)
$ErrorActionPreference = 'Stop'
$PreviewPath = $env:DSBOT_REPAIR_PREVIEW
$script:startupLog = Join-Path $PSScriptRoot 'ui-startup.log'
[System.IO.File]::WriteAllText($script:startupLog, "Starting UI`r`n")
trap {
    [System.IO.File]::AppendAllText($script:startupLog, ($_ | Out-String))
    try { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DS Bot repair tool') | Out-Null } catch {}
    break
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.IO.File]::AppendAllText($script:startupLog, "Assemblies loaded`r`n")
[System.Windows.Forms.Application]::EnableVisualStyles()
if (-not ('DSBotRepairRunner' -as [type])) {
Add-Type -TypeDefinition @'
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
'@
}
[System.IO.File]::AppendAllText($script:startupLog, "Runner compiled`r`n")
$script:root = $PSScriptRoot
$script:runner = $null
$script:lastReport = $null
$script:lastResult = $null
$script:action = ''
if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\DS Bot' }
if (-not $DataHome) { $DataHome = Join-Path $env:USERPROFILE '.ds-bot' }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DS Bot 浏览器 / 电脑操作修复工具 1.0'
$form.ClientSize = New-Object System.Drawing.Size(920, 720)
$form.MinimumSize = New-Object System.Drawing.Size(820, 680)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)

function LabelAt($text, $x, $y, $width, $height) {
    $item = New-Object System.Windows.Forms.Label
    $item.Text = $text; $item.Location = New-Object System.Drawing.Point($x,$y)
    $item.Size = New-Object System.Drawing.Size($width,$height); $form.Controls.Add($item)
    return $item
}
function ButtonAt($text, $x, $y, $width) {
    $item = New-Object System.Windows.Forms.Button
    $item.Text=$text; $item.Location=New-Object System.Drawing.Point($x,$y)
    $item.Size=New-Object System.Drawing.Size($width,36)
    $item.FlatStyle='Flat'; $item.BackColor=[System.Drawing.Color]::White
    $form.Controls.Add($item); return $item
}
$heading=LabelAt '修复浏览器点击 / 输入，以及电脑原生驱动加载' 24 20 870 34
$heading.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',15,[System.Drawing.FontStyle]::Bold)
$subtitle=LabelAt 'Windows x64 · 已验证 DS Bot 0.3.1 · 离线驱动 · 自动备份与回滚' 24 60 870 25
$subtitle.ForeColor=[System.Drawing.Color]::FromArgb(95,105,120)
[void](LabelAt '安装目录' 24 103 94 28)
$appBox=New-Object System.Windows.Forms.TextBox
$appBox.Text=$AppDir; $appBox.Location=New-Object System.Drawing.Point(122,100)
$appBox.Size=New-Object System.Drawing.Size(666,28); $appBox.Anchor='Top,Left,Right'; $form.Controls.Add($appBox)
$appBrowse=ButtonAt '选择…' 800 96 94; $appBrowse.Anchor='Top,Right'
[void](LabelAt '数据目录' 24 148 94 28)
$homeBox=New-Object System.Windows.Forms.TextBox
$homeBox.Text=$DataHome; $homeBox.Location=New-Object System.Drawing.Point(122,145)
$homeBox.Size=New-Object System.Drawing.Size(666,28); $homeBox.Anchor='Top,Left,Right'; $form.Controls.Add($homeBox)
$homeBrowse=ButtonAt '选择…' 800 141 94; $homeBrowse.Anchor='Top,Right'
function PickFolder($box) {
    $dialog=New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.SelectedPath=$box.Text
    if($dialog.ShowDialog($form) -eq 'OK') { $box.Text=$dialog.SelectedPath }
    $dialog.Dispose()
}
$appBrowse.Add_Click({ PickFolder $appBox })
$homeBrowse.Add_Click({ PickFolder $homeBox })
$browserCheck=New-Object System.Windows.Forms.CheckBox
$browserCheck.Text='修复浏览器操控'; $browserCheck.Checked=$true
$browserCheck.Location=New-Object System.Drawing.Point(26,192); $browserCheck.Size=New-Object System.Drawing.Size(220,28)
$form.Controls.Add($browserCheck)
$computerCheck=New-Object System.Windows.Forms.CheckBox
$computerCheck.Text='修复电脑操作'; $computerCheck.Checked=$true
$computerCheck.Location=New-Object System.Drawing.Point(260,192); $computerCheck.Size=New-Object System.Drawing.Size(220,28)
$form.Controls.Add($computerCheck)
$notice=LabelAt "检测只读取状态。修复 / 回滚会完整停止并重启 DS Bot，请先保存当前工作。`r`n修复电脑操作会启用其总开关；每个 Bot 的权限等级与应用授权保持原样。" 24 232 870 50
$notice.Anchor='Top,Left,Right'; $notice.ForeColor=[System.Drawing.Color]::FromArgb(70,80,95)
$detect=ButtonAt '检测' 24 292 130
$repair=ButtonAt '修复并重启' 166 292 170
$repair.BackColor=[System.Drawing.Color]::FromArgb(42,100,219); $repair.ForeColor=[System.Drawing.Color]::White
$rollback=ButtonAt '回滚并重启' 348 292 160
$help=ButtonAt '使用说明' 520 292 130
$reportButton=ButtonAt '打开报告' 662 292 130
$script:statusLabel=LabelAt '准备就绪。点击“检测”查看驱动和配置。' 24 344 870 28
$script:statusLabel.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',10,[System.Drawing.FontStyle]::Bold)
$output=New-Object System.Windows.Forms.TextBox
$output.Multiline=$true; $output.ReadOnly=$true; $output.ScrollBars='Vertical'; $output.WordWrap=$true
$output.Location=New-Object System.Drawing.Point(24,378); $output.Size=New-Object System.Drawing.Size(870,314)
$output.Anchor='Top,Bottom,Left,Right'; $output.BackColor=[System.Drawing.Color]::White
$output.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9)
$form.Controls.Add($output)
$script:buttons=@($detect,$repair,$rollback,$appBrowse,$homeBrowse,$browserCheck,$computerCheck,$appBox,$homeBox)
function AddLog([string]$message) { $output.AppendText($message+[Environment]::NewLine) }
function BeginAction([string]$operation) {
    if($script:runner) { return }
    try {
        $selectedApp=[System.IO.Path]::GetFullPath($appBox.Text.Trim().TrimEnd('\'))
        $selectedHome=[System.IO.Path]::GetFullPath($homeBox.Text.Trim().TrimEnd('\'))
        $exe=Join-Path $selectedApp 'DS Bot.exe'
        if(-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw '请先选择包含 DS Bot.exe 的安装目录。' }
        $parts=New-Object System.Collections.Generic.List[string]
        if($browserCheck.Checked) { $parts.Add('browser') }
        if($computerCheck.Checked) { $parts.Add('computer') }
        if($operation -eq 'repair' -and $parts.Count -eq 0) { throw '请至少选择一项修复功能。' }
        $arguments=@((Join-Path $script:root 'repair.mjs'),$operation,'--app-dir',$selectedApp,'--home',$selectedHome)
        if($operation -eq 'repair') { $arguments+=@('--components',($parts -join ','),'--restart') }
        if($operation -eq 'rollback') { $arguments+=@('--restart') }
        $script:lastResult=$null; $script:action=$operation
        $script:runner=New-Object DSBotRepairRunner
        $output.Clear(); AddLog ('开始：'+$operation)
        $script:statusLabel.Text='正在处理，请等待…'
        foreach($button in $script:buttons) { $button.Enabled=$false }
        $script:runner.Start($exe,[string[]]$arguments,$script:root)
        $timer.Start()
    } catch {
        $script:runner=$null
        foreach($button in $script:buttons) { $button.Enabled=$true }
        $script:statusLabel.Text='未执行：'+$_.Exception.Message
        AddLog $_.Exception.Message
    }
}
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=200
$timer.Add_Tick({
    if(-not $script:runner) { return }
    $line=$null
    while($script:runner.Lines.TryDequeue([ref]$line)) {
        if($line.StartsWith('DSBOT_RESULT:')) {
            try {
                $script:lastResult=$line.Substring(13) | ConvertFrom-Json
                if($script:lastResult.report) { $script:lastReport=$script:lastResult.report }
            } catch { AddLog $line }
        } else { AddLog $line }
        $line=$null
    }
    if($script:runner.Process.HasExited) {
        $script:runner.Process.WaitForExit()
        # Async stdout events may arrive just after HasExited; drain once more.
        $line=$null
        while($script:runner.Lines.TryDequeue([ref]$line)) {
            if($line.StartsWith('DSBOT_RESULT:')) {
                try { $script:lastResult=$line.Substring(13) | ConvertFrom-Json; if($script:lastResult.report) {$script:lastReport=$script:lastResult.report} } catch { AddLog $line }
            } else { AddLog $line }
            $line=$null
        }
        if($script:runner.Process.ExitCode -eq 0 -and $script:lastResult.ok) {
            if($script:action -eq 'detect') { $script:statusLabel.Text='检测完成。请查看下方结果。' }
            else { $script:statusLabel.Text='操作完成。完整功能请按使用说明在 Bot 内验收。' }
        } else { $script:statusLabel.Text='操作失败，请查看下方原因；失败时会尝试恢复本次写入。' }
        $script:runner.Process.Dispose(); $script:runner=$null
        foreach($button in $script:buttons) { $button.Enabled=$true }
        $timer.Stop()
    }
})
$detect.Add_Click({ BeginAction 'detect' })
$repair.Add_Click({ BeginAction 'repair' })
$rollback.Add_Click({ BeginAction 'rollback' })
$help.Add_Click({ Start-Process -FilePath (Join-Path $script:root '使用说明.txt') })
$reportButton.Add_Click({
    if($script:lastReport -and (Test-Path -LiteralPath $script:lastReport)) { Start-Process -FilePath $script:lastReport }
    else { AddLog '请先执行检测，生成本机报告。' }
})
$form.Add_FormClosing({ if($script:runner) { $_.Cancel=$true; $script:statusLabel.Text='任务正在执行，请等待完成后再关闭。' } })
if ($PreviewPath) {
    $form.StartPosition='Manual'
    $form.Location=New-Object System.Drawing.Point(-4000,-4000)
    $form.Show()
    $form.PerformLayout()
    [System.Windows.Forms.Application]::DoEvents()
    BeginAction 'detect'
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while($script:runner -and [DateTime]::UtcNow -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 40
    }
    if($script:runner) { throw 'UI detection timed out' }
    if(-not $script:lastResult.ok) { throw 'UI detection failed' }
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0,0,$form.Width,$form.Height)))
    $bitmap.Save([IO.Path]::GetFullPath($PreviewPath), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose(); $timer.Dispose(); $form.Dispose()
    return
}
[System.IO.File]::AppendAllText($script:startupLog, "Showing UI`r`n")
[void]$form.ShowDialog()
$timer.Dispose(); $form.Dispose()
