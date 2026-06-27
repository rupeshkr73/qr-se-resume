"""
QR Se Resume - Print Agent v2.1.0
System Tray Agent with Auto-Update
"""
import sys, os, time, threading, tempfile, subprocess, requests, json, winreg
from datetime import datetime
from pathlib import Path

# ─── CONFIG (Auto-filled by server during download) ──────────────────────────
SHOP_ID        = "RSHOP_PLACEHOLDER"
SERVER_URL     = "https://qr-se-resume.onrender.com"
VERSION        = "2.1.0"
CHECK_INTERVAL = 5
APP_NAME       = "QRSeResume"
# ─────────────────────────────────────────────────────────────────────────────

LOG_FILE = os.path.join(os.path.dirname(sys.executable if getattr(sys,'frozen',False) else __file__), "agent_log.txt")

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except: pass

# ─── AUTO STARTUP (Registry) ─────────────────────────────────────────────────
def add_to_startup():
    try:
        exe_path = sys.executable if getattr(sys, 'frozen', False) else f'"{sys.executable}" "{os.path.abspath(__file__)}"'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, exe_path)
        winreg.CloseKey(key)
        log("✅ Added to Windows startup")
    except Exception as e:
        log(f"⚠️ Startup registry: {e}", "WARN")

# ─── AUTO UPDATE ─────────────────────────────────────────────────────────────
def check_update():
    try:
        r = requests.get(f"{SERVER_URL}/api/agent/version", timeout=10)
        d = r.json()
        server_ver = d.get("version", VERSION)
        if server_ver != VERSION:
            log(f"🔄 Update available: {VERSION} → {server_ver}")
            if getattr(sys, 'frozen', False):
                # EXE mode — download new EXE
                new_url = f"{SERVER_URL}/downloads/agent.exe?shopId={SHOP_ID}"
                try:
                    resp = requests.get(new_url, timeout=60, stream=True)
                    if resp.status_code == 200:
                        exe_path = sys.executable
                        tmp_path = exe_path + ".new"
                        with open(tmp_path, 'wb') as f:
                            for chunk in resp.iter_content(8192):
                                f.write(chunk)
                        # Schedule replacement on next restart via bat
                        bat = os.path.join(tempfile.gettempdir(), "update_agent.bat")
                        with open(bat, 'w') as f:
                            f.write(f'@echo off\ntimeout /t 3 /nobreak\nmove /y "{tmp_path}" "{exe_path}"\nstart "" "{exe_path}"\ndel "%~f0"\n')
                        log("✅ Update downloaded. Restarting...")
                        update_tray_icon("🔄 Updating...")
                        subprocess.Popen(['cmd', '/c', bat], shell=False, creationflags=subprocess.CREATE_NO_WINDOW)
                        sys.exit(0)
                except Exception as e:
                    log(f"⚠️ EXE update failed: {e}", "WARN")
            else:
                # Script mode — update py file
                new_code = requests.get(f"{SERVER_URL}/downloads/print_agent.py?shopId={SHOP_ID}", timeout=30).text
                script_path = os.path.abspath(__file__)
                with open(script_path, 'w', encoding='utf-8') as f:
                    f.write(new_code)
                log("✅ Script updated. Restarting...")
                os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as e:
        log(f"Update check: {e}", "WARN")

# ─── PRINT FUNCTIONS ─────────────────────────────────────────────────────────
def get_default_printer():
    try:
        import win32print
        return win32print.GetDefaultPrinter()
    except: return "Default Printer"

def get_all_printers():
    try:
        import win32print
        printers = win32print.EnumPrinters(win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        return [p[2] for p in printers]
    except: return ["Default Printer"]

SUMATRA_PATHS = [
    r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
    r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
]

def find_sumatra():
    for p in SUMATRA_PATHS:
        if os.path.exists(p): return p
    return None

def download_pdf(job_id):
    try:
        url = f"{SERVER_URL}/api/jobs/file/{job_id}"
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if not resp.content.startswith(b'%PDF'):
            log("❌ Not a valid PDF", "ERROR"); return None
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.write(resp.content); tmp.close()
        log(f"✅ Downloaded: {len(resp.content):,} bytes")
        return tmp.name
    except Exception as e:
        log(f"❌ Download: {e}", "ERROR"); return None

def print_pdf(filepath, color_mode="bw"):
    sumatra = find_sumatra()
    settings = f"copies=1,{'monochrome,' if color_mode=='bw' else ''}fit"
    if sumatra:
        cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", settings, filepath]
        result = subprocess.run(cmd, timeout=120, capture_output=True)
        if result.returncode == 0:
            log(f"✅ Printed! ({color_mode.upper()})"); return True
        log(f"⚠️ Sumatra error: {result.stderr.decode(errors='ignore')}", "WARN")
    try:
        os.startfile(filepath, "print"); time.sleep(5); return True
    except Exception as e:
        log(f"❌ Print: {e}", "ERROR"); return False

def get_pending_jobs():
    try:
        r = requests.get(f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}", timeout=15)
        return r.json().get("jobs", [])
    except: return []

def mark_complete(job_id):
    try: requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
    except: pass

def mark_failed(job_id, reason=""):
    try: requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}", json={"reason": reason}, timeout=10)
    except: pass

def process_job(job):
    job_id = job["id"]
    color  = job.get("color_mode", "bw")
    name   = job.get("customer_name", "Customer")
    amt    = job.get("amount", 0)
    log(f"📄 {job_id} | {name} | {color.upper()} | ₹{amt}")
    update_tray_icon(f"🖨️ Printing: {name}")
    fp = download_pdf(job_id)
    if not fp: mark_failed(job_id, "Download failed"); update_tray_icon("✅ Ready"); return
    success = print_pdf(fp, color)
    try:
        time.sleep(2)
        if os.path.exists(fp): os.unlink(fp)
    except: pass
    if success:
        mark_complete(job_id); log(f"🎉 Done: {job_id}")
        update_tray_icon("✅ Print Complete!")
        time.sleep(3)
    else:
        mark_failed(job_id, "Print failed")
    update_tray_icon("👀 Waiting for jobs...")

# ─── SYSTEM TRAY ─────────────────────────────────────────────────────────────
tray_icon_ref = None

def update_tray_icon(tooltip):
    global tray_icon_ref
    try:
        if tray_icon_ref:
            tray_icon_ref.title = f"QR Se Resume — {tooltip}"
    except: pass

def create_tray_icon():
    global tray_icon_ref
    try:
        import pystray
        from PIL import Image, ImageDraw

        # Create icon image
        img = Image.new('RGB', (64, 64), color='#2563eb')
        draw = ImageDraw.Draw(img)
        draw.rectangle([8, 8, 56, 56], fill='white')
        draw.rectangle([14, 14, 50, 30], fill='#2563eb')
        draw.rectangle([14, 34, 50, 38], fill='#e2e8f0')
        draw.rectangle([14, 42, 40, 46], fill='#e2e8f0')

        def on_open_log(icon, item):
            try: os.startfile(LOG_FILE)
            except: pass

        def on_quit(icon, item):
            icon.stop()
            sys.exit(0)

        menu = pystray.Menu(
            pystray.MenuItem('QR Se Resume Agent', None, enabled=False),
            pystray.MenuItem(f'Shop: {SHOP_ID}', None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('📋 View Log', on_open_log),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('❌ Exit', on_quit)
        )

        tray_icon_ref = pystray.Icon(
            APP_NAME, img,
            f"QR Se Resume — 👀 Waiting for jobs...",
            menu
        )
        return tray_icon_ref
    except ImportError:
        log("⚠️ pystray/PIL not found — running without tray icon", "WARN")
        return None

# ─── MAIN LOOP ────────────────────────────────────────────────────────────────
def main_loop():
    log(f"🚀 Agent v{VERSION} | Shop: {SHOP_ID} | Server: {SERVER_URL}")
    add_to_startup()
    check_update()

    errors = 0
    chk    = 0
    while True:
        try:
            jobs = get_pending_jobs()
            chk += 1
            if jobs:
                log(f"📬 {len(jobs)} new job(s)!")
                for job in jobs:
                    process_job(job)
                errors = 0
            else:
                if chk % 60 == 0:
                    log(f"👀 Waiting... ({chk*CHECK_INTERVAL//60} min)")
                    check_update()
                update_tray_icon("👀 Waiting for jobs...")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt:
            log("👋 Stopping...")
            break
        except Exception as e:
            errors += 1
            log(f"❌ {e}", "ERROR")
            time.sleep(CHECK_INTERVAL * (2 if errors > 5 else 1))

def main():
    # Run print loop in background thread
    t = threading.Thread(target=main_loop, daemon=True)
    t.start()

    # Try to show system tray
    icon = create_tray_icon()
    if icon:
        icon.run()
    else:
        # No tray — just keep running
        log("Running in console mode (no tray)")
        try:
            while True: time.sleep(10)
        except KeyboardInterrupt:
            log("👋 Bye!")

if __name__ == "__main__":
    main()
