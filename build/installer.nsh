# The checkbox exists only on the interactive finish page. No install hook runs
# trust setup, so silent installs and auto-updates cannot opt into it.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function InstallDashboardTrust
    # Be defensive even though finish pages are never displayed in silent mode.
    ${if} ${Silent}
      Return
    ${endif}
    ${if} ${isUpdated}
      Return
    ${endif}
    # Use the desktop user's token, including after an all-users UAC elevation.
    # Keep the console open so a refusal or a failed import remains visible.
    ${StdUtils.ExecShellAsUser} $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "open" '-NoProfile -NoExit -ExecutionPolicy Bypass -File "$INSTDIR\windows-signing\Install-PR-Dashboard-Trust.ps1" -FromInstaller'
    ${if} $0 != "ok"
    ${andIf} $0 != "fallback"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not start certificate trust setup. Use Install-PR-Dashboard-Trust.ps1 from the release instead."
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Trust this certificate for my Windows account"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "InstallDashboardTrust"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "DashboardFinishShow"
  !insertmacro MUI_PAGE_FINISH

  Function DashboardFinishShow
    ${if} ${isUpdated}
      # An interactive updater must not offer a trust action either.
      ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
    ${endif}
  FunctionEnd

!macroend
