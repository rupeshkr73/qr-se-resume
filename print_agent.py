"""
QR Se Resume - Local Print Agent v1.0
Kaam: Server se pending resume jobs pick karo, print karo, complete mark karo
"""

import requests, time, os, sys, tempfile, subprocess
from datetime import datetime
from pathlib import Path

# ══════════════════════════════════════════
SHOP_ID        = "AAPKA_RSHOP_ID"   # Dashboard se copy karo
SERVER_URL     = "https://qr-se-resume.onrender.com"
CHECK_INTERVAL = 5
LOG_FILE       = "resume_agent_log.txt"
VERSION        = "1.0.0"
# ══════════════════════════════════════════

def log(msg, level="INFO"):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

def show_banner():
    print(f"""
╔══════════════════════════════════════════════╗
║      QR Se Resume - Print Agent v{VERSION}     ║
║   ✅ Auto PDF Print  ✅ B&W / Color           ║
╚══════════════════════════════════════════════╝
""")

def check_printer():
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS)
        if printers:
            default = win32print.GetDefaultPrinter()
            log(f"✅ Printer: {default}")
            return True, default
        log("❌ Printer nahi mila!", "ERROR")
        return False, None
    except ImportError:
        log("⚠️  Mock mode (win32print nahi hai)", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def download_file(url):
    try:
        log(f"⬇️  Downloading resume PDF...")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if len(resp.content) < 100:
            log(f"❌ File bahut choti: {len(resp.content)} bytes", "ERROR")
            return None
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.write(resp.content)
        tmp.close()
        log(f"✅ Downloaded: {tmp.name} ({len(resp.content):,} bytes)")
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

def print_pdf(filepath, color_mode="bw"):
    """SumatraPDF se print — B&W ya Color"""
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]
    settings = f"copies=1,{'monochrome,' if color_mode=='bw' else ''}fit"
    log(f"🖨️  Mode: {color_mode.upper()} | Settings: {settings}")

    for sumatra in sumatra_paths:
        if os.path.exists(sumatra):
            cmd = [sumatra, "-print-to-default", "-silent",
                   "-print-settings", settings, filepath]
            log(f"CMD: {' '.join(cmd)}")
            result = subprocess.run(cmd, timeout=120, capture_output=True)
            if result.returncode == 0:
                log(f"✅ SumatraPDF print success! ({color_mode.upper()})")
                return True
            else:
                err = result.stderr.decode(errors='ignore') if result.stderr else ''
                log(f"⚠️  SumatraPDF error: {err}", "WARN")

    log("⚠️  SumatraPDF nahi mila — Windows shell fallback", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Windows shell se print hua")
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def get_pending_jobs():
    try:
        resp = requests.get(f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}", timeout=15)
        resp.raise_for_status()
        return resp.json().get("jobs", [])
    except requests.ConnectionError:
        log("⚠️  Server connect nahi hua...", "WARN")
        return []
    except Exception as e:
        log(f"❌ Jobs fetch error: {e}", "ERROR")
        return []

def mark_complete(job_id):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/complete/{job_id}", timeout=15)
        log(f"✅ Job {job_id} complete! PDF Cloudinary se delete ho raha hai...")
    except Exception as e:
        log(f"❌ Complete mark error: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}",
                      json={"reason": reason}, timeout=10)
    except:
        pass

def process_job(job):
    job_id  = job.get("id", "unknown")
    url     = job.get("file_url")
    color   = job.get("color_mode", "bw")
    name    = job.get("customer_name", "Customer")
    amount  = job.get("amount", 0)

    log("━" * 42)
    log(f"📄 Job: {job_id}")
    log(f"   Customer: {name}")
    log(f"   Mode: {color.upper()} | ₹{amount}")

    if not url:
        log("❌ File URL nahi!", "ERROR")
        mark_failed(job_id, "No URL")
        return

    filepath = download_file(url)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

    if os.path.getsize(filepath) < 100:
        log("❌ File empty!", "ERROR")
        os.unlink(filepath)
        mark_failed(job_id, "Empty file")
        return

    success = print_pdf(filepath, color)

    try:
        time.sleep(3)
        if os.path.exists(filepath):
            os.unlink(filepath)
            log("🗑️  Local PDF deleted")
    except:
        pass

    if success:
        mark_complete(job_id)
        log(f"🎉 Job {job_id} DONE! Resume print ho gaya!")
    else:
        mark_failed(job_id, "Print failed")
        log(f"❌ Job {job_id} FAILED!", "ERROR")

def main():
    show_banner()
    log(f"🚀 Agent start | Shop: {SHOP_ID}")
    log(f"🌐 Server: {SERVER_URL}")

    printer_ok, printer_name = check_printer()
    if not printer_ok:
        log("❌ Printer nahi mila!", "ERROR")
        input("Enter dabao...")
        sys.exit(1)

    log(f"✅ Printer ready: {printer_name}")
    log("=" * 42)
    log(f"Har {CHECK_INTERVAL}s mein check hoga...")
    log("Ctrl+C se band karo")
    log("=" * 42)

    errors = 0
    check_count = 0
    while True:
        try:
            jobs = get_pending_jobs()
            check_count += 1
            if jobs:
                log(f"📬 {len(jobs)} naya resume job!")
                for job in jobs:
                    process_job(job)
                errors = 0
            else:
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({check_count * CHECK_INTERVAL // 60} min)")
            time.sleep(CHECK_INTERVAL)
        except KeyboardInterrupt:
            log("\n👋 Band ho raha hai...")
            break
        except Exception as e:
            errors += 1
            log(f"❌ Error: {e}", "ERROR")
            time.sleep(CHECK_INTERVAL * (2 if errors > 5 else 1))

if __name__ == "__main__":
    main()
