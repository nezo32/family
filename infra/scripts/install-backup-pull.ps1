<#
.SYNOPSIS
    Registers the backup pull as a Windows scheduled task, and sets up the key.

.DESCRIPTION
    Run once, from an elevated PowerShell, on the PC that should hold the
    backups.

    The task is configured for a machine that is off most of the time: it runs
    a few times a day, and -- crucially -- `StartWhenAvailable` makes Windows run
    a missed occurrence once the PC next wakes, rather than skipping it. A
    schedule that only fires when the PC happens to be on at 04:00 would back up
    almost nothing.

.EXAMPLE
    .\install-backup-pull.ps1
#>
[CmdletBinding()]
param(
    [string] $ServerHost = 'nezo.su',
    [string] $ServerUser = 'familybackup',
    [string] $Destination = "$env:USERPROFILE\Backups\family",
    [string] $IdentityFile = "$env:USERPROFILE\.ssh\family_backup",
    [string] $TaskName = 'Family app - pull database backups'
)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'backup-pull.ps1'
if (-not (Test-Path $scriptPath)) { throw "backup-pull.ps1 not found beside this script" }

Write-Host "`n=== 1. SSH key ===" -ForegroundColor Cyan
if (-not (Test-Path $IdentityFile)) {
    Write-Host "Generating a dedicated backup key (no passphrase -- it must run unattended)."
    & ssh-keygen -t ed25519 -f $IdentityFile -N '""' -C "family-backup@$env:COMPUTERNAME"
} else {
    Write-Host "Reusing existing key: $IdentityFile"
}

Write-Host "`nAdd this public key to the server's backup user:" -ForegroundColor Yellow
Write-Host "  ssh root@$ServerHost `"echo '$(Get-Content "$IdentityFile.pub")' >> /home/$ServerUser/.ssh/authorized_keys`"" -ForegroundColor Yellow

Write-Host "`n=== 2. Destination ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Write-Host $Destination

Write-Host "`n=== 3. Scheduled task ===" -ForegroundColor Cyan
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" " +
               "-ServerHost $ServerHost -ServerUser $ServerUser " +
               "-Destination `"$Destination`" -IdentityFile `"$IdentityFile`"")

# Several times a day rather than once: this PC is off for long stretches, and
# more attempts simply means a shorter wait for the first one that connects.
# 14:00 is the intended time. The extra triggers are catch-up, not extra
# backups -- the script itself skips a run when the newest backup it holds is
# under 20h old, so at most one is taken per day. Without them, a PC that
# happens to be off at 14:00 would simply never back up.
$triggers = @(
    (New-ScheduledTaskTrigger -Daily -At 14:00),
    (New-ScheduledTaskTrigger -Daily -At 19:00),
    (New-ScheduledTaskTrigger -AtLogOn)
)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Settings $settings `
    -Description 'Pulls the family app database dumps from the VDI. Pull rather than push, because this PC is behind NAT and is not always on.' `
    -Force | Out-Null

Write-Host "Registered: $TaskName"

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host @"
Once the public key is on the server, test it now:

    Start-ScheduledTask -TaskName '$TaskName'
    Get-Content '$Destination\_log\pull-$(Get-Date -Format yyyy-MM).log' -Tail 20

To restore a dump into a throwaway container and check it is real:

    ssh root@$ServerHost 'cd /opt/family && ./infra/scripts/restore-check.sh'
"@
