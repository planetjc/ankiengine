; Hooks into the installer Tauri generates (bundle.windows.nsis.installerHooks).
; installer.nsi inserts each hook only if it is defined, so only the one used
; here is declared.
;
; The installer takes its install folder, shortcuts and registry keys from
; productName. Renamed from APE to AnkiEngine, it installs beside a copy made
; under the old name and leaves that one in place: listed twice in Installed
; apps, with a shortcut that starts the old app. This removes the old copy once
; the new one is in.
;
; The user's data is not in the install folder. It is in $APPDATA\com.ankiengine.ape
; and $LOCALAPPDATA\com.ankiengine.ape, and nothing here goes near either. The
; bundle identifier did not change, so the new build finds it where it was left.
;
; Everything below concerns the install made by 0.3.2 or earlier. Its shortcuts
; move to the new copy wherever the old one is: left pointing at it, they would
; start 0.3.2, which would offer this update again on every launch. Its folder
; and Installed apps entry go only from the default folder, $LOCALAPPDATA\APE;
; one the user put somewhere of their own is theirs to uninstall.

; Moves one shortcut over from the old name. An update (the updater passes
; /UPDATE) makes no shortcuts, so deleting APE.lnk alone would leave the user
; none; make the new one the way installer.nsi does, then remove the old. A
; shortcut that points anywhere but at the old install is not touched.
!macro APE_MOVE_OLD_SHORTCUT dir old
  ${If} ${FileExists} "${dir}\APE.lnk"
    !insertmacro IsShortcutTarget "${dir}\APE.lnk" "${old}\ape-app.exe"
    Pop $0
    ${If} $0 = 1
      ${IfNot} ${FileExists} "${dir}\${PRODUCTNAME}.lnk"
        CreateShortcut "${dir}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "${dir}\${PRODUCTNAME}.lnk"
      ${EndIf}
      !insertmacro UnpinShortcut "${dir}\APE.lnk"
      Delete "${dir}\APE.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Where the old installer recorded its folder; the default if it recorded none.
  ; $R8 survives the shortcut macros, which use $0-$3.
  ReadRegStr $R8 SHCTX "${MANUKEY}\APE" ""
  ${If} $R8 == ""
    StrCpy $R8 "$LOCALAPPDATA\APE"
  ${EndIf}

  ; No startMenuFolder is set, so the old shortcuts sit directly in Programs.
  !insertmacro APE_MOVE_OLD_SHORTCUT "$SMPROGRAMS" "$R8"
  !insertmacro APE_MOVE_OLD_SHORTCUT "$DESKTOP" "$R8"

  ${If} $R8 == "$LOCALAPPDATA\APE"
    ; Installed apps entry and install-folder record. SHCTX is HKCU for the
    ; per-user install used today; HKCU as well in case that mode changes, since
    ; the old ones were written there.
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\APE"
    DeleteRegKey SHCTX "${MANUKEY}\APE"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\APE"
    DeleteRegKey HKCU "${MANUKEY}\APE"

    ; Only a folder that holds ape-app.exe, and never the one the new copy was
    ; just installed into: $0 is $INSTDIR cut to the length of the old folder.
    StrLen $R9 "$LOCALAPPDATA\APE\"
    StrCpy $0 "$INSTDIR\" $R9
    ${If} ${FileExists} "$LOCALAPPDATA\APE\ape-app.exe"
    ${AndIf} $0 != "$LOCALAPPDATA\APE\"
      RMDir /r /REBOOTOK "$LOCALAPPDATA\APE"
    ${EndIf}
  ${EndIf}
!macroend
