# Invoice Maker

Offline invoice, quotation and credit-note app (Expo / React Native) with GST support, UPI QR codes, customers, items and stock.
All data is stored on the device. There is no server.

## Setup

```bash
npm install
npx expo install expo-secure-store expo-crypto   # aligns versions with your Expo SDK
npx expo start
```

`expo-secure-store` and `expo-crypto` are native modules: make a new EAS build (`eas build`) after updating.

## Security notes

- The PIN is salted and hashed in the device keystore (`expo-secure-store`), never in AsyncStorage or backups. Wrong attempts trigger a growing lockout, and the app re-locks after a minute in the background.
- Backups are plain text. The Restore screen validates and sanitises every field and asks for confirmation before changing UPI or bank details.
- UPI IDs are validated before a QR code or link is built. Printed bills use a strict Content-Security-Policy.
- Android auto-backup is disabled (`allowBackup: false`) so app data is not copied to cloud or adb backups.

## Legal

See [TERMS.md](./TERMS.md). The same text is shown in the app (More > Terms & Conditions) and must be accepted on first launch.
Edit `terms.js`, bump `TERMS_VERSION` when the text changes, and regenerate `TERMS.md`. The Terms include the Privacy Policy and the Developer / Grievance Officer contact (shabaj9769@gmail.com).
