<#
.SYNOPSIS
    Pulls the family database backups from the VDI down to this PC.

.DESCRIPTION
    The PC pulls; the server never pushes.

    That direction is not a style choice. This PC sits behind NAT with no
    inbound port and no stable address, and it is off for most of the day -- a
    server-side `scp` would fail more often than it succeeded, and giving the
    VDI a route into a home machine is a far worse trade than the reverse.
    Pulling means the PC needs no open ports, and a missed night simply catches
    up on the next run.

    Verifies each archive before deleting anything, keeps a local retention
    window longer than the server's, and is safe to run on a schedule.

.EXAMPLE
    .\backup-pull.ps1
    .\backup-pull.ps1 -Destination D:\backups\family -KeepDays 180
#>
[CmdletBinding()]
param(
    [string] $ServerHost = 'nezo.su',
    [string] $ServerUser = 'backup',
    [string] $RemoteDir  = '/opt/family/backups',
    [string] $Destination = "$env:USERPROFILE\Backups\family",
    [string] $IdentityFile = "$env:USERPROFILE\.ssh\family_backup",
    [int]    $KeepDays = 180,
    [int]    $ConnectTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $Destination '_log'
New-Item -ItemType Directory -Force -Path $Destination, $logDir | Out-Null
$logFile = Join-Path $logDir ('pull-{0}.log' -f (Get-Date -Format 'yyyy-MM'))

function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 's'), $Level, $Message
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Write-Log "Pull starting -> $Destination"

# --- reachability ---------------------------------------------------------
# The whole point of this design is that the PC is often awake when the link
# is not. A failed connection is normal operation, not an incident.
$sshArgs = @(
    '-o', 'BatchMode=yes'
    '-o', "ConnectTimeout=$ConnectTimeoutSeconds"
    '-o', 'StrictHostKeyChecking=accept-new'
)
if (Test-Path $IdentityFile) { $sshArgs += @('-i', $IdentityFile) }

$remote = "$ServerUser@$ServerHost"
& ssh @sshArgs $remote 'true' 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Log "Server unreachable; nothing to do this run." 'WARN'
    exit 0
}

# --- what does the server have? -------------------------------------------
$listing = & ssh @sshArgs $remote "ls -1 $RemoteDir/*.sql.gz 2>/dev/null" 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($listing)) {
    Write-Log "No dumps found in ${RemoteDir}." 'WARN'
    exit 0
}
$remoteFiles = @($listing -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Write-Log ("Server holds {0} dump(s)." -f $remoteFiles.Count)

# --- copy only what we do not already have --------------------------------
$copied = 0
foreach ($remotePath in $remoteFiles) {
    $name = Split-Path $remotePath -Leaf
    $localPath = Join-Path $Destination $name

    if (Test-Path $localPath) { continue }

    # Copy to a temp name first, so an interrupted transfer can never be
    # mistaken for a complete backup by a later run.
    $tempPath = "$localPath.partial"
    Write-Log "Fetching $name"
    & scp @sshArgs "${remote}:$remotePath" $tempPath 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Transfer failed for $name; will retry next run." 'WARN'
        Remove-Item $tempPath -ErrorAction SilentlyContinue
        continue
    }

    # Verify the gzip stream before this file is allowed to count as a backup.
    # An archive nobody has ever read is not a backup, it is a hope.
    $ok = $false
    try {
        $stream = [System.IO.File]::OpenRead($tempPath)
        try {
            $gzip = New-Object System.IO.Compression.GzipStream(
                $stream, [System.IO.Compression.CompressionMode]::Decompress)
            try {
                $buffer = New-Object byte[] 65536
                $total = 0
                while (($read = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) { $total += $read }
                $ok = $total -gt 0
                if ($ok) { Write-Log ("  verified, {0:N0} bytes uncompressed" -f $total) }
            } finally { $gzip.Dispose() }
        } finally { $stream.Dispose() }
    } catch {
        Write-Log "  gzip verification FAILED for ${name}: $($_.Exception.Message)" 'ERROR'
    }

    if ($ok) {
        Move-Item $tempPath $localPath -Force
        $copied++
    } else {
        Remove-Item $tempPath -ErrorAction SilentlyContinue
    }
}

Write-Log "Copied $copied new dump(s)."

# --- local retention ------------------------------------------------------
# Deliberately longer than the server's 7-day window: the whole reason this
# copy exists is to outlive whatever happens to the VDI.
$cutoff = (Get-Date).AddDays(-$KeepDays)
$stale = Get-ChildItem -Path $Destination -Filter '*.sql.gz' |
         Where-Object { $_.LastWriteTime -lt $cutoff }

# Never prune down to nothing, however old everything is.
$remaining = (Get-ChildItem -Path $Destination -Filter '*.sql.gz').Count
foreach ($file in $stale) {
    if ($remaining -le 3) { break }
    Write-Log ("Pruning {0} (older than {1} days)" -f $file.Name, $KeepDays)
    Remove-Item $file.FullName -Force
    $remaining--
}

# --- report ---------------------------------------------------------------
$all = Get-ChildItem -Path $Destination -Filter '*.sql.gz' | Sort-Object LastWriteTime -Descending
if ($all.Count -eq 0) {
    Write-Log "No local backups present after this run." 'ERROR'
    exit 1
}
$newest = $all[0]
$ageHours = [int]((Get-Date) - $newest.LastWriteTime).TotalHours
$sizeMb = [math]::Round(($all | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Log ("Local set: {0} file(s), {1} MB. Newest: {2} ({3}h old)." -f `
    $all.Count, $sizeMb, $newest.Name, $ageHours)

if ($ageHours -gt 72) {
    Write-Log "Newest backup is over 72h old -- check the server's cron job." 'WARN'
}
