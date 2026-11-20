$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $projectRoot '.env.local'
$nodeScript = Join-Path $PSScriptRoot 'create-super-admin.mjs'

if (-not (Test-Path $envFile)) {
  throw 'Could not find .env.local. Configure the Supabase project URL first.'
}

$urlLine = Get-Content $envFile | Where-Object { $_ -match '^\s*VITE_SUPABASE_URL\s*=' } | Select-Object -First 1
if (-not $urlLine) {
  throw 'VITE_SUPABASE_URL is missing from .env.local.'
}

$projectUrl = ($urlLine -replace '^\s*VITE_SUPABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
if ($projectUrl -notmatch '^https://[a-zA-Z0-9-]+\.supabase\.co/?$') {
  throw 'VITE_SUPABASE_URL in .env.local is not a standard Supabase project URL.'
}

$email = (Read-Host 'Email address for the first Super Admin').Trim().ToLowerInvariant()
$displayName = (Read-Host 'Name for the first Super Admin').Trim()
if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or -not $displayName -or $displayName.Length -gt 200) {
  throw 'Enter a valid email address and a name up to 200 characters.'
}

Write-Host 'This creates one separate Super Admin account. It cannot create other Super Admins.'
Write-Host 'The account can manage staff only; it has no report or student access.'
Write-Host 'A unique temporary password will be saved locally and must be changed at first sign-in.'
$secureKey = Read-Host 'Paste the Supabase service-role/secret key (input is hidden)' -AsSecureString
if (-not $secureKey -or $secureKey.Length -lt 1) {
  throw 'A Supabase service-role/secret key is required.'
}

$keyPointer = [IntPtr]::Zero
$plainKey = $null
$previousUrl = $env:SUPABASE_URL
$previousKey = $env:SUPABASE_SERVICE_ROLE_KEY
$locationPushed = $false

try {
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $env:SUPABASE_URL = $projectUrl
  $env:SUPABASE_SERVICE_ROLE_KEY = $plainKey
  Push-Location $projectRoot
  $locationPushed = $true

  & node $nodeScript $email $displayName
  if ($LASTEXITCODE -ne 0) {
    throw 'The preflight check failed. No Super Admin account was created.'
  }

  $confirmation = Read-Host 'If this is the correct project and email, type CREATE to continue'
  if ($confirmation -cne 'CREATE') {
    Write-Host 'Cancelled. No Super Admin account was created.'
    return
  }

  & node $nodeScript $email $displayName --apply
  if ($LASTEXITCODE -ne 0) {
    throw 'Super Admin setup failed. Read the error above and do not rerun without checking the account status.'
  }
} finally {
  $env:SUPABASE_URL = $previousUrl
  $env:SUPABASE_SERVICE_ROLE_KEY = $previousKey
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  if ($plainKey) {
    $plainKey = $null
  }
  if ($secureKey) {
    $secureKey.Dispose()
  }
  if ($locationPushed) {
    Pop-Location
  }
}
