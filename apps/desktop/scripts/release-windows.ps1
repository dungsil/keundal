param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('import', 'sign-host', 'verify', 'cleanup')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$certificatePath = Join-Path $env:RUNNER_TEMP 'keundal-release.pfx'

try {
  switch ($Action) {
    'import' {
      if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE) -or [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
        throw 'Missing Windows signing credentials'
      }
      try {
        [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
        $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -Force -AsPlainText
        $certificates = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password |
          Where-Object { $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') })
        if ($certificates.Count -ne 1) { throw 'Expected one code signing private key' }
        if ($certificates[0].NotAfter -le (Get-Date)) { throw 'Expired Windows signing certificate' }
        "WINDOWS_CERTIFICATE_THUMBPRINT=$($certificates[0].Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
      } finally {
        Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
      }
    }
    'sign-host' {
      if ($env:WINDOWS_CERTIFICATE_THUMBPRINT -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Missing certificate thumbprint' }
      $signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
        Sort-Object FullName -Descending | Select-Object -First 1
      if (-not $signtool) { throw 'signtool was not found' }
      # Sign after prepare-sidecar copies Node, and before NSIS embeds it.
      & $signtool.FullName sign /sha1 $env:WINDOWS_CERTIFICATE_THUMBPRINT /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 'apps/desktop/src-tauri/binaries/keundal-host-x86_64-pc-windows-msvc.exe' *> $null
      if ($LASTEXITCODE -ne 0) { throw 'Sidecar code signing failed' }
    }
    'verify' {
      $paths = @(
        'apps/desktop/src-tauri/binaries/keundal-host-x86_64-pc-windows-msvc.exe',
        'apps/desktop/src-tauri/target/release/keundal-host.exe',
        'apps/desktop/src-tauri/target/release/keundal-desktop.exe'
      )
      $installers = @(Get-ChildItem 'apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe')
      if ($installers.Count -ne 1) { throw 'Expected one NSIS installer' }
      $paths += $installers[0].FullName
      foreach ($path in $paths) {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $env:WINDOWS_CERTIFICATE_THUMBPRINT) {
          throw 'Windows code signature verification failed'
        }
      }
    }
    'cleanup' {
      Remove-Item -LiteralPath $certificatePath -Force -ErrorAction SilentlyContinue
      if ($env:WINDOWS_CERTIFICATE_THUMBPRINT -match '^[A-Fa-f0-9]{40}$') {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$env:WINDOWS_CERTIFICATE_THUMBPRINT" -Force -ErrorAction SilentlyContinue
      }
    }
  }
} catch {
  # PowerShell's default exception formatting can include the source and secret values.
  Write-Error -Message "Windows release signing step failed: $Action" -ErrorAction Continue
  exit 1
}
