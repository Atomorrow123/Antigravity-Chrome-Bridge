param(
    [switch]$Uninstall,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$argsList = @("$PSScriptRoot\install.js")
if ($Uninstall) { $argsList += "--uninstall" }
if ($DryRun)    { $argsList += "--dry-run" }
node @argsList
