; electron-builder retries closing a running app, but its silent cancel path calls Quit.
!macro customInit
  ${If} ${Silent}
    SetErrorLevel 2
  ${EndIf}
!macroend

!macro banneretInstalled
  ; Banneret Hub: electron-builder registers URL schemes on macOS and Linux only.
  WriteRegStr SHCTX "Software\Classes\banneret" "" "URL:Banneret Hub"
  WriteRegStr SHCTX "Software\Classes\banneret" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\banneret\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\banneret\shell\open\command" "" '"$appExe" "%1"'
  ${If} ${Silent}
    SetErrorLevel 0
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\banneret"
!macroend
