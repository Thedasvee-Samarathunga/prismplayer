
; Extra steps for the Windows installer (electron-builder includes this file automatically).
!macro customInstall
  ; Tell Explorer that icons changed (SHCNE_ASSOCCHANGED). Shortcuts, the taskbar and the Start menu keep showing an old or BLANK icon from the icon
  ; cache of a previous install until this happens (or until the next sign-in).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ; The shortcuts are made around this point of the install, so the refresh is done AGAIN a few seconds later (in the background, hidden, after the installer has
  ; finished), when the program and its shortcuts are certainly in place. ie4uinit.exe -show is Windows' own "redraw all icons" command (Windows 10 / 11).
  ExecShell "open" "$SYSDIR\cmd.exe" '/c "ping -n 5 127.0.0.1 >nul & ie4uinit.exe -show"' SW_HIDE
!macroend
