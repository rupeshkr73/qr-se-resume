"""
QR Se Resume - Local Print Agent v2.0
Fix: PDF seedha server se download hota hai — Cloudinary nahi, 401 nahi!
"""

import requests
import time
import os
import sys
import tempfile
import subprocess
from datetime import datetime
from pathlib import Path

# ============================================================
SHOP_ID        = "AAPKA_RSHOP_ID"   # Dashboard se copy karo
SERVER_URL     = "https://qr-se-resume.onrender.com"
CHECK_INTERVAL = 5
LOG_FILE       = "resume_agent_log.txt"
VERSION        = "2.0.0"
# ============================================================

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
║    QR Se Resume - Print Agent v{VERSION}      ║
║  ✅ No Cloudinary  ✅ Direct Download         ║
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

def download_pdf(job_id):
    """Server se directly PDF download karo — no Cloudinary, no 401!"""
    try:
        url = f"{SERVER_URL}/api/jobs/file/{job_id}"
        log(f"⬇️  Downloading PDF from server: {url}")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()

        if len(resp.content) < 100:
            log(f"❌ PDF too small: {len(resp.content)} bytes", "ERROR")
            return None

        # Check it's actually a PDF
        if not resp.content.startswith(b'%PDF'):
            log(f"❌ Not a valid PDF file!", "ERROR")
            return None

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp.write(resp.content)
        tmp.close()
        log(f"✅ PDF downloaded: {tmp.name} ({len(resp.content):,} bytes)")
        return tmp.name

    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

def print_pdf(filepath, color_mode="bw"):
    """SumatraPDF se print karo"""
    sumatra_paths = [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]
    settings = f"copies=1,{'monochrome,' if color_mode=='bw' else ''}fit"
    log(f"🖨️  Printing — Mode: {color_mode.upper()} | Settings: {settings}")

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

    # Fallback
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
        log(f"✅ Job {job_id} complete! PDF server se delete ho gaya.")
    except Exception as e:
        log(f"❌ Complete mark error: {e}", "ERROR")

def mark_failed(job_id, reason=""):
    try:
        requests.post(f"{SERVER_URL}/api/jobs/failed/{job_id}",
                      json={"reason": reason}, timeout=10)
    except:
        pass

def process_job(job):
    job_id = job.get("id", "unknown")
    color  = job.get("color_mode", "bw")
    name   = job.get("customer_name", "Customer")
    amount = job.get("amount", 0)

    log("━" * 42)
    log(f"📄 Job: {job_id}")
    log(f"   Customer: {name}")
    log(f"   Mode: {color.upper()} | ₹{amount}")

    # Download PDF directly from server
    filepath = download_pdf(job_id)
    if not filepath:
        mark_failed(job_id, "Download failed")
        return

    # Print
    success = print_pdf(filepath, color)

    # Delete local temp file
    try:
        time.sleep(2)
        if os.path.exists(filepath):
            os.unlink(filepath)
            log("🗑️  Local PDF deleted")
    except:
        pass

    if success:
        mark_complete(job_id)
        log(f"🎉 Job {job_id} DONE!")
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
    log(f"Har {CHECK_INTERVAL}s mein check hoga... | Ctrl+C se band karo")
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
