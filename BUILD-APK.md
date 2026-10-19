# ساخت APK — Phone Flipper One

## روش ۱: خودکار با GitHub Actions (بدون نیاز به نصب چیزی)

1. این پروژه را در یک مخزن GitHub قرار دهید (push کنید).
2. فایل `.github/workflows/android-apk.yml` به صورت خودکار اجرا می‌شود.
3. از تب **Actions** مخزن، آخرین اجرای "Build Android APK" را باز کنید.
4. از بخش **Artifacts** فایل `phone-flipper-one-debug-apk` را دانلود کنید.
5. فایل `app-debug.apk` را روی گوشی نصب کنید (نصب از منابع ناشناس را فعال کنید).

## روش ۲: محلی با Android Studio

پیش‌نیازها: Node.js 20+، JDK 21، Android Studio (یا Android SDK + build-tools 35).

```bash
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

خروجی: `android/app/build/outputs/apk/debug/app-debug.apk`

برای نسخه release امضا شده:

```bash
npx cap build android --keystorepath my.keystore --keystorepass *** \
  --keystorealias myalias --keystorealiaspass *** --androidreleasetype APK
```

## قابلیت‌های نسخه APK (که در وب فعال نیستند)

| قابلیت | سخت‌افزار لازم |
|---|---|
| ارسال واقعی IR با پروتکل NEC / Samsung / Sony SIRC | گوشی با فرستنده Consumer IR (شیائومی، برخی سامسونگ‌ها و...) |
| شناسایی خودکار برند تلویزیون (IR discovery) | فرستنده IR داخلی یا Arduino IR Bridge |
| اسکن BLE بومی و کاوش GATT | همه گوشی‌های اندروید |
| اتصال Arduino از USB-OTG (CDC/FTDI/CP210x/CH34x) | کابل OTG |
| اتصال Arduino از Bluetooth Classic (HC-05/06) | pair در تنظیمات اندروید |
| خواندن UID و NDEF تگ‌های NFC + نوشتن NDEF | گوشی با NFC |
| مغناطیس‌سنج (uT) + نور + مجاورت + فشار هوا | سنسورهای داخلی گوشی |
| شتاب، جهت‌گیری، تحلیل طیف صوتی میکروفون، GPS | سنسورهای داخلی گوشی |

## محدودیت‌های فیزیکی (قابل حذف با نرم‌افزار نیستند)

- گیرنده/فرستنده Sub-GHz (315/433/868 MHz) در هیچ گوشی‌ای وجود ندارد؛ ESP32 + CC1101 لازم است.
- خواندن سکتورهای رمزنگاری شده MIFARE Classic خارج از توان NFC استاندارد اندروید بدون کلید است.
- گیرنده IR (یادگیری کد از ریموت) در اکثر گوشی‌ها وجود ندارد؛ فقط فرستنده.
