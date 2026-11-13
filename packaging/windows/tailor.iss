; Inno Setup script for the Windows installer. CI runs it after PyInstaller:
;     iscc packaging\windows\tailor.iss
; It packs dist\Tailor into dist\installer\Tailor-Setup-<version>.exe.

#define AppVersion "0.1.0"

[Setup]
AppId={{09238770-C9DD-470B-8A89-7D28C868F104}
AppName=Tailor
AppVersion={#AppVersion}
AppPublisher=Tailor
DefaultDirName={autopf}\Tailor
DefaultGroupName=Tailor
DisableProgramGroupPage=yes
; Installs for the current user, so no administrator prompt is needed.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=Tailor-Setup-{#AppVersion}
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\Tailor.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "..\..\dist\Tailor\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Tailor"; Filename: "{app}\Tailor.exe"
Name: "{autodesktop}\Tailor"; Filename: "{app}\Tailor.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Tailor.exe"; Description: "Open Tailor"; Flags: nowait postinstall skipifsilent
