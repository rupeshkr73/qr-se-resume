# -*- mode: python ; coding: utf-8 -*-
block_cipher = None

a = Analysis(
    ['agent_tray.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'win32print', 'win32api', 'win32con',
        'pystray', 'PIL', 'PIL.Image', 'PIL.ImageDraw',
        'requests', 'winreg'
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'scipy'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, a.binaries, a.zipfiles, a.datas,
    [],
    name='QRSeResume_Agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,          # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    uac_admin=False,
    icon=None,              # Add .ico file here if you have one
)
