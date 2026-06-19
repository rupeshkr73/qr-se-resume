# QR Se Resume Banao 📄

> Customer QR scan kare, resume bana ke pay kare, automatic print ho jaye!

## 🚀 Deploy Steps

### 1. GitHub
```bash
git init
git add .
git commit -m "Initial commit — QR Se Resume v1.0"
git branch -M main
git remote add origin https://github.com/AAPKA_USERNAME/qr-se-resume.git
git push -u origin main
```

### 2. Render (Web Service)
- New → Web Service → GitHub se connect
- Build Command: `npm install`
- Start Command: `node server.js`
- Environment Variables set karo (neeche dekho)

### 3. Render PostgreSQL
- New → PostgreSQL
- `DATABASE_URL` environment variable mein paste karo

### 4. Environment Variables (Render mein set karo)
```
DATABASE_URL        = (Render PostgreSQL se copy karo)
CLOUDINARY_CLOUD_NAME = xxxxx
CLOUDINARY_API_KEY    = xxxxx
CLOUDINARY_API_SECRET = xxxxx
RAZORPAY_KEY_ID       = rzp_live_xxxxx
RAZORPAY_KEY_SECRET   = xxxxx
BASE_URL              = https://qr-se-resume.onrender.com
```

### 5. Apni Dukaan Register Karo
- `https://qr-se-resume.onrender.com/dashboard` pe jao
- "Register New Shop" mein details bharo
- QR code download karo aur print karke dukaan pe lagao

### 6. PC Print Agent Setup
- `INSTALL.bat` run karo
- Dashboard se apna Shop ID copy karke paste karo
- `RUN_AGENT.bat` se agent start karo

## 📁 File Structure
```
qr-se-resume/
├── server.js          ← Backend (Node.js + Express)
├── package.json
├── print_agent.py     ← Windows PC pe print karne wala agent
├── INSTALL.bat        ← One-click Windows installer
├── requirements.txt
├── .env.example       ← Environment variables template
└── public/
    ├── index.html     ← Landing page
    ├── dashboard.html ← Admin dashboard (shop management)
    └── resume.html    ← Customer resume builder
```

## 💡 How It Works
1. Customer dukaan ka QR scan karta hai
2. Template select karta hai (6 designs)
3. Form bharta hai (name, education table, skills, photo)
4. Resume PDF ban jata hai browser mein (Cloudinary pe upload)
5. Payment karta hai (Razorpay / Counter)
6. PC pe agent print job pick karta hai aur automatically print karta hai
7. Print hone ke baad PDF Cloudinary se delete ho jata hai

## 🖨️ Agent Commands
```bash
pip install requests pywin32
python print_agent.py
```

---
*Developed by Rupesh Kumar Mahato | instagram.com/rupeshkr73*
