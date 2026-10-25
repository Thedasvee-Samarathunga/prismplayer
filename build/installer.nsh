; Extra steps for the Windows installer (electron-builder includes this file automatically).
!macro customInstall
  ; Tell Explorer that icons changed (SHCNE_ASSOCCHANGED). Shortcuts, the taskbar and the Start menu keep showing an old or blank icon from the icon
  ; cache of a previous install until this happens (or until the next sign-in).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
