"""
QR Se Resume - Print Agent v2.2.0
- System Tray (no black window)
- Auto startup on Windows boot
- Auto update from server
- Shop ID setup wizard on first run
- Auto detect printer
"""
import sys, os, time, threading, tempfile, subprocess
import requests, json, winreg, ctypes
from datetime import datetime
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
SERVER_URL     = "https://qr-se-resume.onrender.com"
VERSION        = "2.4.0"
CHECK_INTERVAL = 5
APP_NAME       = "QRSeResume"

# Config/log AB %APPDATA% me store hote hain, exe ke bagal me NAHI.
# Reason: exe Downloads/Program Files/USB kahin bhi ho sakta hai — wahan
# write fail hota hai (permission), config save nahi hota, aur har boot
# pe setup wizard dobara khulta hai. APPDATA hamesha writable hota hai.
_EXE_DIR    = os.path.dirname(sys.executable
                 if getattr(sys,'frozen',False) else os.path.abspath(__file__))
CONFIG_DIR  = os.path.join(os.environ.get("APPDATA", _EXE_DIR), APP_NAME)
try: os.makedirs(CONFIG_DIR, exist_ok=True)
except Exception: CONFIG_DIR = _EXE_DIR
CONFIG_FILE = os.path.join(CONFIG_DIR, "agent_config.json")
LOG_FILE    = os.path.join(CONFIG_DIR, "agent_log.txt")
_OLD_CONFIG = os.path.join(_EXE_DIR, "agent_config.json")  # purani location (migration)

# ── Logging ───────────────────────────────────────────────────────────────────
def log(msg, level="INFO"):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    # CRITICAL FIX: --noconsole exe me sys.stdout None hota hai —
    # bina guard ke print() har call pe AttributeError deta tha, jisse
    # poora agent (setup ke baad, boot pe, print loop me) crash ho jata tha.
    try:
        if sys.stdout: print(line, flush=True)
    except Exception: pass
    try:
        # Log rotation — unbounded growth se Disk bharne na paye
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
            old = LOG_FILE + ".old"
            if os.path.exists(old): os.remove(old)
            os.rename(LOG_FILE, old)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except: pass

# ── Config read/write ─────────────────────────────────────────────────────────
def load_config():
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except:
        pass
    # Migration: purane version ne config exe ke bagal me rakha tha —
    # mil jaye to APPDATA me le aao taaki dobara setup na maangna pade
    try:
        with open(_OLD_CONFIG, "r") as f:
            cfg = json.load(f)
        save_config(cfg)
        return cfg
    except:
        return {}

def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
        return True
    except:
        return False

# ── Printer helpers ───────────────────────────────────────────────────────────
def get_all_printers():
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        return [p[2] for p in printers]
    except:
        return []

def get_default_printer():
    try:
        import win32print
        return win32print.GetDefaultPrinter()
    except:
        return ""

def auto_detect_printer():
    """Returns default printer or first available"""
    default = get_default_printer()
    if default:
        log(f"✅ Auto-detected printer: {default}")
        return default
    printers = get_all_printers()
    if printers:
        log(f"✅ First printer found: {printers[0]}")
        return printers[0]
    log("⚠️ No printer found", "WARN")
    return ""

# ── Setup Wizard (first run) ──────────────────────────────────────────────────
def run_setup_wizard():
    """Show simple input dialog for Shop ID"""
    try:
        import tkinter as tk
        from tkinter import messagebox, ttk

        root = tk.Tk()
        root.title("QR Se Resume — Agent Setup")
        root.geometry("420x380")
        root.resizable(False, False)
        root.configure(bg="#1e3a8a")

        # Center on screen
        root.update_idletasks()
        x = (root.winfo_screenwidth()  - 420) // 2
        y = (root.winfo_screenheight() - 380) // 2
        root.geometry(f"420x380+{x}+{y}")
        root.lift()
        root.focus_force()

        result = {"shop_id": None, "printer": None, "done": False}

        # Header
        tk.Label(root, text="📄", font=("Arial",32), bg="#1e3a8a", fg="white").pack(pady=(20,5))
        tk.Label(root, text="QR Se Resume", font=("Arial",16,"bold"),
                 bg="#1e3a8a", fg="white").pack()
        tk.Label(root, text="Print Agent Setup", font=("Arial",11),
                 bg="#1e3a8a", fg="#93c5fd").pack(pady=(2,18))

        frame = tk.Frame(root, bg="#2563eb", padx=24, pady=20)
        frame.pack(fill="x", padx=20)

        # Shop ID input
        tk.Label(frame, text="Shop ID (Dashboard se copy karo):",
                 font=("Arial",10,"bold"), bg="#2563eb", fg="white",
                 anchor="w").pack(fill="x")
        shop_var = tk.StringVar()
        entry = tk.Entry(frame, textvariable=shop_var, font=("Arial",12,"bold"),
                         bg="#1e3a8a", fg="#4ade80", insertbackground="#4ade80",
                         relief="flat", bd=6)
        entry.pack(fill="x", pady=(6,14))
        entry.focus()

        # Printer selection
        tk.Label(frame, text="Printer:", font=("Arial",10,"bold"),
                 bg="#2563eb", fg="white", anchor="w").pack(fill="x")

        printers      = get_all_printers()
        default_p     = get_default_printer()
        printer_opts  = ["🔍 Auto Detect"] + printers
        printer_var   = tk.StringVar(value="🔍 Auto Detect")

        printer_combo = ttk.Combobox(frame, textvariable=printer_var,
                                     values=printer_opts, state="readonly",
                                     font=("Arial",10))
        printer_combo.pack(fill="x", pady=(6,0))

        status_lbl = tk.Label(root, text="", font=("Arial",9),
                              bg="#1e3a8a", fg="#fbbf24")
        status_lbl.pack(pady=8)

        def do_setup():
            sid = shop_var.get().strip().upper()
            if not sid:
                status_lbl.config(text="❌ Shop ID daalna zaroori hai!")
                return
            if not sid.startswith("RSHOP_"):
                status_lbl.config(text="❌ Shop ID RSHOP_ se shuru hona chahiye")
                return

            # Verify shop ID with server
            status_lbl.config(text="⏳ Verifying Shop ID...")
            root.update()
            try:
                # timeout 30s — Render free tier sleep se jaagne me 30-60s
                # leta hai; 10s timeout pe user ko galat lagta tha ki ID
                # wrong hai jabki server bas cold-start me tha
                r = requests.get(f"{SERVER_URL}/api/shop/{sid}", timeout=30)
                if r.status_code == 200:
                    shop = r.json()
                    psel = printer_var.get()
                    if psel == "🔍 Auto Detect":
                        psel = auto_detect_printer()
                    result["shop_id"] = sid
                    result["printer"] = psel
                    result["shop_name"] = shop.get("name","")
                    result["done"] = True
                    status_lbl.config(text=f"✅ Shop: {shop.get('name','')}")
                    root.after(1200, root.destroy)
                elif r.status_code == 404:
                    status_lbl.config(text="❌ Shop ID nahi mila! Check karo.")
                else:
                    status_lbl.config(text=f"❌ Server error: {r.status_code}")
            except requests.exceptions.Timeout:
                status_lbl.config(text="⏳ Server jaag raha hai — 30 sec baad dobara Save dabao")
            except requests.exceptions.ConnectionError:
                # Server unreachable — still save (offline mode)
                psel = printer_var.get()
                if psel == "🔍 Auto Detect":
                    psel = auto_detect_printer()
                result["shop_id"] = sid
                result["printer"] = psel
                result["done"] = True
                status_lbl.config(text="⚠️ Saved (Server offline)")
                root.after(1500, root.destroy)
            except Exception as e:
                status_lbl.config(text=f"⚠️ {str(e)[:40]}")

        btn = tk.Button(root, text="✅ Save & Start Agent",
                        font=("Arial",11,"bold"), bg="#16a34a", fg="white",
                        relief="flat", padx=20, pady=10, cursor="hand2",
                        command=do_setup)
        btn.pack(pady=4)
        entry.bind("<Return>", lambda e: do_setup())

        tk.Label(root, text="Developed by Rupesh Kumar Mahato",
                 font=("Arial",8), bg="#1e3a8a",
                 fg="#93c5fd").pack(side="bottom", pady=8)

        # sys.exit() tkinter callback me SystemExit raise karta hai jo tkinter
        # ke error handler me phans jata hai (aur noconsole me stderr None hone
        # se aur bhi kharab). destroy() safe hai — result.done False rahega
        # aur main() khud exit kar dega.
        root.protocol("WM_DELETE_WINDOW", root.destroy)
        root.mainloop()

        if result["done"]:
            return result["shop_id"], result["printer"], result.get("shop_name","")
        return None, None, None

    except ImportError:
        # No tkinter — fallback to console
        print("\n=== QR Se Resume Agent Setup ===")
        sid = input("Shop ID daalo (RSHOP_XXXXXXXX): ").strip().upper()
        printer = auto_detect_printer()
        return sid, printer, ""

# ── Auto Startup ──────────────────────────────────────────────────────────────
def add_to_startup():
    try:
        if getattr(sys, 'frozen', False):
            exe = sys.executable
        else:
            exe = f'"{sys.executable}" "{os.path.abspath(__file__)}"'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, exe)
        winreg.CloseKey(key)
        log("✅ Startup registered")
    except Exception as e:
        log(f"⚠️ Startup: {e}", "WARN")

# ── Auto Update ───────────────────────────────────────────────────────────────
def _ver_tuple(v):
    try: return tuple(int(x) for x in str(v).strip().split("."))
    except: return (0,)

def check_update(shop_id):
    try:
        r = requests.get(f"{SERVER_URL}/api/agent/version", timeout=8)
        if r.status_code != 200: return
        d = r.json()
        sv = d.get("version", VERSION)
        # SIRF newer version pe update — pehle `sv != VERSION` tha, jisse
        # naya exe deploy karne par (server version endpoint update karna
        # bhool jao to) agent khud ko purane version se replace karke
        # infinite update-restart loop me phans jata tha
        if _ver_tuple(sv) <= _ver_tuple(VERSION): return
        log(f"🔄 Update: {VERSION} → {sv}")
        if getattr(sys, 'frozen', False):
            new_exe_url = f"{SERVER_URL}/downloads/QRSeResume_Agent.exe"
            resp = requests.get(new_exe_url, timeout=120, stream=True)
            if resp.status_code == 200:
                cur = sys.executable
                tmp = cur + ".new"
                with open(tmp, 'wb') as f:
                    for chunk in resp.iter_content(65536):
                        if chunk: f.write(chunk)
                bat = os.path.join(tempfile.gettempdir(), "qrresume_update.bat")
                # move retry loop — running exe overwrite nahi hota jab tak
                # process zinda hai, isliye tab tak retry karo
                with open(bat, 'w') as f:
                    f.write('@echo off\nset /a tries=0\n:loop\n'
                            'timeout /t 2 /nobreak >nul\n'
                            f'move /y "{tmp}" "{cur}" >nul 2>&1\n'
                            'if not errorlevel 1 goto ok\n'
                            'set /a tries+=1\nif %tries% lss 15 goto loop\n'
                            'goto end\n:ok\n'
                            f'start "" "{cur}"\n:end\ndel "%~f0"\n')
                log("✅ Update downloaded, restarting...")
                subprocess.Popen(['cmd','/c',bat],
                    creationflags=subprocess.CREATE_NO_WINDOW)
                # sys.exit() yahan SIRF is daemon thread ko marta tha —
                # tray/process zinda rehta, exe file locked rehti, move
                # fail hota aur update kabhi apply nahi hota. os._exit
                # poora process turant band karta hai.
                os._exit(0)
        else:
            resp = requests.get(
                f"{SERVER_URL}/downloads/print_agent.py?shopId={shop_id}",
                timeout=30)
            # 404/error HTML se apni source file overwrite mat karo
            if resp.status_code == 200 and "def main" in resp.text:
                with open(os.path.abspath(__file__), 'w', encoding='utf-8') as f:
                    f.write(resp.text)
                os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as e:
        log(f"Update check: {e}", "WARN")

# ── Print ─────────────────────────────────────────────────────────────────────
SUMATRA = [
    r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
    r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
    os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
]

def find_sumatra():
    for p in SUMATRA:
        if os.path.exists(p): return p
    return None

def download_pdf(job_id):
    try:
        r = requests.get(f"{SERVER_URL}/api/jobs/file/{job_id}", timeout=60)
        r.raise_for_status()
        if not r.content.startswith(b'%PDF'):
            log("❌ Invalid PDF", "ERROR"); return None
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.write(r.content); tmp.close()
        log(f"✅ PDF ready: {len(r.content):,} bytes")
        return tmp.name
    except Exception as e:
        log(f"❌ Download: {e}", "ERROR"); return None

def print_pdf(filepath, color_mode, printer_name):
    sumatra = find_sumatra()
    mode    = f"copies=1,{'monochrome,' if color_mode=='bw' else ''}fit"
    if sumatra:
        cmd = [sumatra, "-print-to",
               printer_name if printer_name else "-default",
               "-silent", "-print-settings", mode, filepath]
        r = subprocess.run(cmd, timeout=120, capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        if r.returncode == 0:
            log(f"✅ Printed ({color_mode.upper()})"); return True
        log(f"⚠️ Sumatra: {r.stderr.decode(errors='ignore')}", "WARN")
    try:
        os.startfile(filepath, "print"); time.sleep(5); return True
    except Exception as e:
        log(f"❌ Print: {e}", "ERROR"); return False

server_settings = {}  # dashboard se aayi printer settings (har poll refresh)

def get_jobs(shop_id):
    global server_settings
    try:
        r = requests.get(f"{SERVER_URL}/api/jobs/pending/{shop_id}", timeout=15)
        d = r.json()
        server_settings = d.get("settings") or {}
        return d.get("jobs", [])
    except: return []

def report_printers(shop_id):
    """Installed printers server ko bhejo — owner dashboard mein select karega"""
    try:
        printers = get_all_printers()
        if printers:
            requests.post(f"{SERVER_URL}/api/agent/printers/{shop_id}",
                          json={"printers": printers}, timeout=15)
            log(f"📋 Printer list bheji: {printers}")
    except Exception as e:
        log(f"⚠️ Printer report fail: {e}", "WARN")

def pick_printer(color_mode, fallback):
    """
    Priority: (1) Advanced approved ho to color_mode ke hisaab se BW/Color
    printer, (2) dashboard ka selected printer, (3) local config/default.
    Windows ka default printer kya hai — isse koi matlab nahi.
    """
    st = server_settings or {}
    if st.get("advanced"):
        p = st.get("printer_color") if color_mode == "color" else st.get("printer_bw")
        if p: return p
    return st.get("printer") or fallback

def mark_done(job_id):
    try: requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
    except: pass

def mark_fail(job_id, reason=""):
    try: requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}",
                       json={"reason": reason}, timeout=10)
    except: pass

# ── Tray Icon ─────────────────────────────────────────────────────────────────
tray_ref = [None]

def update_tray(msg):
    try:
        if tray_ref[0]:
            tray_ref[0].title = f"QR Se Resume — {msg}"
    except: pass

def make_icon_image():
    try:
        from PIL import Image, ImageDraw
        img  = Image.new("RGBA", (64,64), (0,0,0,0))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle([0,0,63,63], radius=14, fill="#2563eb")
        draw.rectangle([10,12,54,48], fill="white")
        draw.rectangle([16,18,48,24], fill="#2563eb")
        draw.rectangle([16,28,48,30], fill="#e2e8f0")
        draw.rectangle([16,34,36,36], fill="#e2e8f0")
        draw.rectangle([16,40,44,42], fill="#2563eb")
        return img
    except:
        from PIL import Image
        return Image.new("RGB",(64,64),"#2563eb")

def run_tray(shop_id, shop_name, printer):
    try:
        import pystray
        from PIL import Image

        def open_log(icon, item):
            try: os.startfile(LOG_FILE)
            except: pass

        def change_shop(icon, item):
            icon.stop()
            # Remove config and restart
            try: os.remove(CONFIG_FILE)
            except: pass
            # Release mutex so the new instance can acquire it
            try:
                if _mutex_handle[0]:
                    ctypes.windll.kernel32.ReleaseMutex(_mutex_handle[0])
                    ctypes.windll.kernel32.CloseHandle(_mutex_handle[0])
            except: pass
            exe = sys.executable if getattr(sys,'frozen',False) else sys.executable
            args = [exe] + ([] if getattr(sys,'frozen',False) else [__file__])
            subprocess.Popen(args, creationflags=subprocess.CREATE_NO_WINDOW)
            sys.exit(0)

        def quit_app(icon, item):
            icon.stop(); sys.exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("QR Se Resume Agent", None, enabled=False),
            pystray.MenuItem(f"Shop: {shop_name or shop_id}", None, enabled=False),
            pystray.MenuItem(f"Printer: {printer or 'Default'}", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("📋 View Log",   open_log),
            pystray.MenuItem("🔄 Change Shop ID", change_shop),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("❌ Exit",        quit_app),
        )

        icon = pystray.Icon(APP_NAME, make_icon_image(),
                            f"QR Se Resume — Shop: {shop_name or shop_id}", menu)
        tray_ref[0] = icon
        icon.run()
    except ImportError:
        log("⚠️ pystray not available — running headless", "WARN")
        try:
            while True: time.sleep(60)
        except KeyboardInterrupt: pass

# ── Main loop ─────────────────────────────────────────────────────────────────
def print_loop(shop_id, printer):
    log(f"🚀 Agent v{VERSION} | Shop: {shop_id} | Printer: {printer or 'Default'}")
    check_update(shop_id)
    report_printers(shop_id)
    errors = 0; chk = 0
    while True:
        try:
            jobs = get_jobs(shop_id); chk += 1
            if jobs:
                log(f"📬 {len(jobs)} job(s)!")
                for job in jobs:
                    jid   = job["id"]
                    color = job.get("color_mode","bw")
                    name  = job.get("customer_name","Customer")
                    amt   = job.get("amount",0)
                    log(f"📄 {jid} | {name} | {color.upper()} | ₹{amt}")
                    update_tray(f"🖨️ Printing: {name}")
                    fp = download_pdf(jid)
                    if not fp:
                        mark_fail(jid, "Download failed")
                        update_tray("👀 Waiting...")
                        continue
                    job_printer = pick_printer(color, printer)
                    log(f"🖨️ Printer: {job_printer or 'Default'} ({color.upper()})")
                    ok = print_pdf(fp, color, job_printer)
                    try:
                        time.sleep(2)
                        if os.path.exists(fp): os.unlink(fp)
                    except: pass
                    if ok:
                        mark_done(jid); log(f"🎉 Done: {jid}")
                        update_tray("✅ Printed!")
                        time.sleep(2)
                    else:
                        mark_fail(jid,"Print failed")
                    update_tray("👀 Waiting for jobs...")
                errors = 0
            else:
                if chk % 60 == 0:
                    log(f"👀 Waiting... ({chk*CHECK_INTERVAL//60}m)")
                    check_update(shop_id)
                    report_printers(shop_id)  # naya printer lage to dashboard mein dikhe
                update_tray("👀 Waiting for jobs...")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt: break
        except Exception as e:
            errors += 1; log(f"❌ {e}", "ERROR")
            time.sleep(CHECK_INTERVAL * (2 if errors > 5 else 1))

# ── Entry ─────────────────────────────────────────────────────────────────────
# ── Single Instance Lock ───────────────────────────────────────────────────────
MUTEX_NAME = "Global\\QRSeResume_Agent_SingleInstance_Lock"
_mutex_handle = [None]

def ensure_single_instance():
    """Returns True if this is the only running instance. False if another is already running."""
    try:
        ERROR_ALREADY_EXISTS = 183
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        last_error = ctypes.windll.kernel32.GetLastError()
        if last_error == ERROR_ALREADY_EXISTS:
            return False
        _mutex_handle[0] = handle
        return True
    except Exception as e:
        log(f"⚠️ Mutex check failed: {e}", "WARN")
        return True  # Allow running if check fails (fail-open)

def kill_other_instances():
    """Kill any other running QRSeResume_Agent.exe processes (cleanup for old duplicates)."""
    try:
        my_pid = os.getpid()
        exe_name = "QRSeResume_Agent.exe"
        result = subprocess.run(
            ['tasklist', '/FI', f'IMAGENAME eq {exe_name}', '/FO', 'CSV', '/NH'],
            capture_output=True, text=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        lines = result.stdout.strip().split('\n')
        killed = 0
        for line in lines:
            if exe_name in line:
                try:
                    parts = line.replace('"','').split(',')
                    pid = int(parts[1])
                    if pid != my_pid:
                        subprocess.run(['taskkill', '/F', '/PID', str(pid)],
                                       capture_output=True, timeout=5,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
                        killed += 1
                except: continue
        if killed:
            log(f"🧹 Cleaned up {killed} duplicate instance(s)")
    except Exception as e:
        log(f"⚠️ Cleanup skipped: {e}", "WARN")

def main():
    # ── Prevent duplicate instances (fixes tray icon spam) ──
    if getattr(sys, 'frozen', False):
        kill_other_instances()  # One-time cleanup of any stragglers from before this fix
        if not ensure_single_instance():
            log("⛔ Agent already running — exiting this duplicate instance")
            sys.exit(0)

    cfg = load_config()
    shop_id    = cfg.get("shop_id","")
    printer    = cfg.get("printer","")
    shop_name  = cfg.get("shop_name","")

    # First run — show setup wizard
    if not shop_id:
        shop_id, printer, shop_name = run_setup_wizard()
        if not shop_id:
            sys.exit(0)
        # Auto-detect printer if not selected
        if not printer:
            printer = auto_detect_printer()
        saved = save_config({"shop_id": shop_id, "printer": printer,
                             "shop_name": shop_name, "version": VERSION})
        if not saved:
            # Pehle yeh silently fail hota tha → har boot pe wizard dobara.
            # Ab user ko pata chalega.
            log(f"❌ Config save FAILED: {CONFIG_FILE}", "ERROR")
            try:
                import tkinter as tk
                from tkinter import messagebox
                _r = tk.Tk(); _r.withdraw()
                messagebox.showwarning("QR Se Resume",
                    f"Config save nahi hui:\n{CONFIG_FILE}\n\n"
                    "Agent abhi chalega, par agle restart pe Shop ID dobara maangega.")
                _r.destroy()
            except: pass
        else:
            log(f"✅ Config saved: {shop_id} | {printer}")

    add_to_startup()

    # Print loop in background thread
    t = threading.Thread(target=print_loop, args=(shop_id, printer), daemon=True)
    t.start()

    # System tray (blocks until exit)
    run_tray(shop_id, shop_name, printer)

if __name__ == "__main__":
    main()
