# build.ps1 — construit le dossier portable ModLingo-Hub-live\ (Windows).
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   ... -Out C:\chemin\ModLingo-Hub-live        dossier de sortie (défaut : tools\livemod\dist\ModLingo-Hub-live)
#   ... -NodeExe C:\node\node.exe     n'utilise PAS le réseau : copie ce node.exe
#   ... -WithCache                    inclut le cache de traductions Minecraft du projet
# Le téléchargement de Node est vérifié avec l'empreinte SHA-256 publiée sur nodejs.org.
param(
    [string]$Out = (Join-Path $PSScriptRoot 'dist\ModLingo-Hub-live'),
    [string]$NodeExe = '',
    [switch]$WithCache
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Dep = Join-Path $Out 'Dependence'; $NodeDir = Join-Path $Dep 'node'
New-Item -ItemType Directory -Force -Path $Dep | Out-Null

if ($NodeExe) {
    Write-Host "Node : copie de $NodeExe (hors ligne)"
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
    Copy-Item $NodeExe (Join-Path $NodeDir 'node.exe')
} else {
    $arch = if ([Environment]::Is64BitOperatingSystem) { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' } } else { throw 'Windows 32 bits non géré' }
    $major = (Get-Content (Join-Path $PSScriptRoot 'node-major.txt') -Raw).Trim()
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("livemod-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        Write-Host "Node : recherche de la dernière LTS $major.x…"
        $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
        $entry = $index | Where-Object { $_.version -like "v$major.*" -and $_.lts } | Select-Object -First 1
        if (-not $entry) { throw "Aucune LTS $major.x trouvée" }
        $version = $entry.version; $file = "node-$version-win-$arch.zip"
        Write-Host "Node : $version ($file)"
        $sums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
        $line = ($sums -split "`n") | Where-Object { $_.Trim().EndsWith("  $file") } | Select-Object -First 1
        if (-not $line) { throw "Empreinte introuvable pour $file" }
        $expected = ($line.Trim() -split '\s+')[0]
        Invoke-WebRequest "https://nodejs.org/dist/$version/$file" -OutFile (Join-Path $tmp $file) -UseBasicParsing
        $actual = (Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected) { throw 'ERREUR : empreinte SHA-256 différente, archive rejetée.' }
        Write-Host 'Node : empreinte SHA-256 vérifiée'
        Expand-Archive (Join-Path $tmp $file) -DestinationPath $tmp -Force
        if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
        Move-Item (Join-Path $tmp "node-$version-win-$arch") $NodeDir
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
$node = Join-Path $NodeDir 'node.exe'
$v = & $node -v
if ($LASTEXITCODE -ne 0) { throw 'Le Node installé ne démarre pas' }
Write-Host "Node : $v prêt"

# Paquets npm (express, adm-zip, fast-xml-parser) : build.js les copie depuis <racine>\node_modules.
# Dans un dépôt fraîchement cloné ils n'y sont pas : on les installe avec le npm du Node portable (versions verrouillées, sans scripts).
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$missing = @('express', 'adm-zip', 'fast-xml-parser') | Where-Object { -not (Test-Path (Join-Path $repo "node_modules\$_")) }
if ($missing) {
    $npmCli = if ($env:LIVEMOD_NPM_CLI) { $env:LIVEMOD_NPM_CLI } else { Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js' }
    if (-not (Test-Path $npmCli)) { throw "npm introuvable ($npmCli) : lance « npm install » à la racine du dépôt puis relance build.ps1." }
    $cmd = if (Test-Path (Join-Path $repo 'package-lock.json')) { 'ci' } else { 'install' }
    Write-Host "Paquets npm : npm $cmd (express, adm-zip, fast-xml-parser…)"
    Push-Location $repo
    try { & $node $npmCli $cmd --omit=dev --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm $cmd a échoué" } } finally { Pop-Location }
}

$args2 = @((Join-Path $PSScriptRoot 'build.js'), '--out', $Out)
if ($WithCache) { $args2 += '--with-cache' }
& $node @args2
if ($LASTEXITCODE -ne 0) { throw 'build.js a échoué' }
Write-Host ""
Write-Host "Dossier prêt : $Out"
Write-Host "Lancer       : $Out\LiveMod.cmd"
