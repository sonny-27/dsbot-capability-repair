$ErrorActionPreference='Stop'
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$automation=Join-Path $env:SystemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll'
Push-Location $PSScriptRoot
try {
    & $compiler /nologo /target:winexe /optimize+ /out:DSBot-Repair.exe /reference:System.Windows.Forms.dll ("/reference:"+$automation) .\Launcher.cs .\Runner.cs
    if($LASTEXITCODE -ne 0){throw 'GUI compilation failed'}
} finally { Pop-Location }
