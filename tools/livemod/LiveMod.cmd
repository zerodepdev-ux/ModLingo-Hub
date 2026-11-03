@echo off
rem ModLingo-Hub-live - lanceur Windows. Usage : ModLingo-Hub-live [setup^|start^|stop^|info^|edit^|add^|connect^|update-node]
rem Runtime : Dependence\node (portable) en priorite, sinon node du PATH.
setlocal
set "HERE=%~dp0"
set "DEP=%HERE%Dependence"

rem Mise a jour de Node preparee au lancement precedent : on l'echange maintenant (retour arriere si elle ne demarre pas).
if exist "%DEP%\node.new\.ready" (
    if exist "%DEP%\node.old" rmdir /s /q "%DEP%\node.old"
    move "%DEP%\node" "%DEP%\node.old" >nul 2>&1 && move "%DEP%\node.new" "%DEP%\node" >nul 2>&1
    del "%DEP%\node\.ready" >nul 2>&1
    "%DEP%\node\node.exe" -v >nul 2>&1 || (
        echo ModLingo-Hub-live : mise a jour de Node annulee, retour a l'ancienne version.
        rmdir /s /q "%DEP%\node" >nul 2>&1
        move "%DEP%\node.old" "%DEP%\node" >nul 2>&1
    )
)

if exist "%DEP%\node\node.exe" (
    "%DEP%\node\node.exe" "%HERE%livemod.js" %*
) else (
    node "%HERE%livemod.js" %*
)
exit /b %ERRORLEVEL%
