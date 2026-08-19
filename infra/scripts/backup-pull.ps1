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

    Runs about once a day: the schedule fires several times so a machine that
    was asleep still catches up, and the script itself skips the run when the
    newest backup it holds is less than -MinIntervalHours old.

    Overwrites rather than accumulates. The file is named for the weekday, so
    the set is exactly -Generations files that each get replaced once a week.
    Verification happens BEFORE the overwrite, so a truncated download can never
    replace a good backup.

.EXAMPLE
    .\backup-pull.ps1
    .\backup-pull.ps1 -Destination D:\backups\family -KeepDays 180
#>
[CmdletBinding()]
param(
    [string] $ServerHost = 'nezo.su',
    [string] $ServerUser = 'familybackup',
    [string] $RemoteDir  = '/opt/family/backups',
    [string] $Destination = "$env:USERPROFILE\Backups\family",
    [string] $IdentityFile = "$env:USERPROFILE\.ssh\family_backup",
    # How many rotating slots to keep. 7 = one per weekday, each overwritten
    # weekly. 1 = a single `latest` file, overwritten every run.
    [int]    $Generations = 7,
    # Skip the run when the newest local backup is younger than this. 20h rather
    # than 24 so a slightly-late run does not push the next one a day out.
    [int]    $MinIntervalHours = 20,
    [switch] $Force,
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

# --- has a backup already been taken recently? ---------------------------
# The schedule fires more than once so a machine that was asleep at 14:00 still
# catches up, but the backup itself should happen about once a day. Deciding on
# the age of what we already hold -- rather than on the clock -- means a missed
# day is retried promptly and a normal day is not backed up three times.
$existing = @(Get-ChildItem -Path $Destination -Filter '*.sql.gz' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending)
if (-not $Force -and $existing.Count -gt 0) {
    $ageHours = ((Get-Date) - $existing[0].LastWriteTime).TotalHours
    if ($ageHours -lt $MinIntervalHours) {
        Write-Log ("Last backup is {0:N1}h old (threshold {1}h) -- nothing to do." -f $ageHours, $MinIntervalHours)
        exit 0
    }
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

# --- copy the newest dump, under a rotating weekday name -------------------
# Overwrite rather than accumulate, as asked. The name is the weekday, so the
# set is exactly seven files that each get replaced once a week: constant disk,
# old backups genuinely overwritten, and still a week of history.
#
# Seven rather than one on purpose. A single overwritten file means the moment a
# dump is truncated or the database is already corrupt, the good copy is gone --
# the backup destroys the thing it exists to protect. Set -Generations 1 if you
# really want exactly one.
$newestRemote = $remoteFiles | Select-Object -Last 1
$copied = 0

if ($newestRemote) {
    $slot = if ($Generations -le 1) { 'latest' }
            else { (Get-Date).ToString('ddd', [Globalization.CultureInfo]::InvariantCulture).ToLower() }
    $localPath = Join-Path $Destination ("family-db-{0}.sql.gz" -f $slot)
    $tempPath  = "$localPath.partial"

    Write-Log ("Fetching {0} -> {1}" -f (Split-Path $newestRemote -Leaf), (Split-Path $localPath -Leaf))
    & scp @sshArgs "${remote}:$newestRemote" $tempPath 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Transfer failed; keeping the previous copy and retrying next run." 'WARN'
        Remove-Item $tempPath -ErrorAction SilentlyContinue
    }
    else {
        # Verify BEFORE overwriting. Replacing a good backup with a corrupt one
        # is the failure this whole script exists to avoid.
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
            Write-Log "  gzip verification FAILED: $($_.Exception.Message)" 'ERROR'
        }

        if ($ok) {
            Move-Item $tempPath $localPath -Force   # the overwrite
            $copied = 1
        } else {
            Remove-Item $tempPath -ErrorAction SilentlyContinue
            Write-Log "Refusing to overwrite the previous backup with an unverified file." 'ERROR'
        }
    }
}

Write-Log "Copied $copied dump(s)."

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
