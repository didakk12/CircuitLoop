# ==============================================================================
# CircuitLoop Windows Telemetry Agent
# Collects Windows memory/process telemetry and sends it to the backend.
# ==============================================================================

$BackendUrl = "https://backend-d9y6.onrender.com/api/v1/telemetry"
$AgentId = $env:COMPUTERNAME
$IntervalSec = 10

function Get-SystemMetrics {

    # --------------------------------------------------------------------------
    # System & Memory Telemetry
    # --------------------------------------------------------------------------

    $OS = Get-CimInstance Win32_OperatingSystem
    $Perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory

    $TotalMB = [math]::Round($OS.TotalVisibleMemorySize / 1KB, 2)
    $FreeMB = [math]::Round($OS.FreePhysicalMemory / 1KB, 2)
    $UsedMB = [math]::Round($TotalMB - $FreeMB, 2)
    $UsedPct = [math]::Round(($UsedMB / $TotalMB) * 100, 2)

    $StandbyMB = [math]::Round($Perf.StandbyCacheBytes / 1MB, 2)
    $ModMB = [math]::Round($Perf.ModifiedPageListBytes / 1MB, 2)
    $HardFaults = $Perf.PageFaultsPerSec

    # --------------------------------------------------------------------------
    # Top 10 Processes by RAM Usage
    # --------------------------------------------------------------------------

    $TopProcs = Get-Process |
        Sort-Object WorkingSet64 -Descending |
        Select-Object -First 10 |
        ForEach-Object {

            [PSCustomObject]@{
                pid = $_.Id
                name = $_.ProcessName
                working_set_mb = [math]::Round($_.WorkingSet64 / 1MB, 2)
                commit_mb = [math]::Round($_.PrivateMemorySize64 / 1MB, 2)
            }
        }

    # --------------------------------------------------------------------------
    # Construct Telemetry Payload
    # --------------------------------------------------------------------------

    return [PSCustomObject]@{
        agent_id = $AgentId

        timestamp = (Get-Date).ToUniversalTime().ToString(
            "yyyy-MM-ddTHH:mm:ssZ"
        )

        system_metrics = @{
            memory = @{
                total_gb = [math]::Round($TotalMB / 1024, 2)
                used_mb = $UsedMB
                free_mb = $FreeMB
                used_percent = $UsedPct
                standby_mb = $StandbyMB
                modified_mb = $ModMB
                hard_faults_per_sec = $HardFaults
            }
        }

        top_processes = $TopProcs
    }
}

# ==============================================================================
# Main Monitoring Loop
# ==============================================================================

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " CircuitLoop Windows Telemetry Agent" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Agent ID : $AgentId"
Write-Host "Backend  : $BackendUrl"
Write-Host "Interval : $IntervalSec seconds"
Write-Host ""

while ($true) {

    try {

        # Collect and serialize telemetry
        $PayloadObject = Get-SystemMetrics
        $Payload = $PayloadObject | ConvertTo-Json -Depth 6

        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Sending telemetry..." -ForegroundColor Gray

        # Send telemetry to backend
        $Response = Invoke-RestMethod `
            -Uri $BackendUrl `
            -Method Post `
            -Body $Payload `
            -ContentType "application/json" `
            -TimeoutSec 5

        # ----------------------------------------------------------------------
        # Handle Backend Response
        # ----------------------------------------------------------------------

        if ($Response.status -eq "NORMAL") {

            Write-Host "[NORMAL] PC health is within configured thresholds." `
                -ForegroundColor Green
        }

        elseif ($Response.status -eq "ACTION_REQUIRED") {

            Write-Host "[ALERT] Backend requested action: $($Response.action_id)" `
                -ForegroundColor Yellow

            switch ($Response.action_id) {

                "KILL_PROCESS" {

    if ($null -eq $Response.target_pid) {
        Write-Host `
            "[SAFETY] Backend did not provide a target PID. No action taken." `
            -ForegroundColor Magenta

        break
    }

    $TargetProcess = Get-Process `
        -Id $Response.target_pid `
        -ErrorAction SilentlyContinue

    if ($null -eq $TargetProcess) {

        Write-Host `
            "[INFO] Target process PID $($Response.target_pid) no longer exists." `
            -ForegroundColor Cyan

        break
    }

    # --------------------------------------------------------------------------
    # Safety Layer 1: Never terminate the agent itself
    # --------------------------------------------------------------------------

    if ($Response.target_pid -eq $PID) {

        Write-Host `
            "[SAFETY] Refused to terminate the telemetry agent itself." `
            -ForegroundColor Magenta

        break
    }

    # --------------------------------------------------------------------------
    # Safety Layer 2: Never terminate protected Windows processes
    # --------------------------------------------------------------------------

    $ProtectedProcesses = @(
        "System",
        "System Idle Process",
        "Registry",
        "smss",
        "csrss",
        "wininit",
        "services",
        "lsass",
        "svchost",
        "winlogon",
        "explorer",
        "dwm",
        "powershell",
        "pwsh",
        "cmd",
        "node",
        "npm",
        "code"
    )

    if ($ProtectedProcesses -contains $TargetProcess.ProcessName) {

        Write-Host `
            "[SAFETY] Refused to terminate protected process '$($TargetProcess.ProcessName)'." `
            -ForegroundColor Magenta

        break
    }

    # --------------------------------------------------------------------------
    # Safety Layer 3: Require explicit confirmation for real remediation
    # --------------------------------------------------------------------------

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host " REMEDIATION REQUEST" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Yellow
    Write-Host "Process : $($TargetProcess.ProcessName)"
    Write-Host "PID     : $($TargetProcess.Id)"
    Write-Host ""

    $Confirmation = Read-Host "Type YES to allow termination of this process"

    if ($Confirmation -ne "YES") {

        Write-Host `
            "[SAFETY] Termination cancelled by user." `
            -ForegroundColor Magenta

        break
    }

    # --------------------------------------------------------------------------
    # Execute approved remediation
    # --------------------------------------------------------------------------

    try {

        Stop-Process `
            -Id $TargetProcess.Id `
            -Force `
            -ErrorAction Stop

        Write-Host `
            "[ACTION] Terminated process '$($TargetProcess.ProcessName)' PID $($TargetProcess.Id)." `
            -ForegroundColor Red
    }
    catch {

        Write-Host `
            "[ERROR] Failed to terminate process: $($_.Exception.Message)" `
            -ForegroundColor Red
    }
}
                "EMPTY_WORKING_SETS" {

                    [GC]::Collect()

                    Write-Host `
                        "[ACTION] Triggered garbage collection." `
                        -ForegroundColor Cyan
                }

                default {

                    Write-Host `
                        "[WARNING] Unknown action: $($Response.action_id)" `
                        -ForegroundColor Yellow
                }
            }
        }
    }

    catch {

        Write-Host `
            "[ERROR] Failed to collect/send telemetry: $($_.Exception.Message)" `
            -ForegroundColor Red
    }

    Start-Sleep -Seconds $IntervalSec
}