// Terms & Conditions for Invoice Maker.
// Bump TERMS_VERSION whenever the text changes: the app will ask every user to accept the new version.
// Before publishing: fill in the two [bracketed] placeholders in sections 17 and 18.

export const TERMS_VERSION = '2026-10-19';
export const TERMS_UPDATED = 'October 19, 2026';

export const TERMS = [
  {
    h: 'About this app',
    p: [
      'Invoice Maker (the "App") is a mobile tool that helps small businesses create invoices, quotations and credit notes, track payments, customers and items, produce GST summaries and share documents. These Terms and Conditions ("Terms") govern your use of the App.',
      'In these Terms, "you" means the person or business using the App, and "we" or "the developer" means the creator and publisher of the App.',
    ],
  },
  {
    h: 'Accepting these Terms',
    p: [
      'By tapping "I Agree" or by using the App, you confirm that you have read and accepted these Terms. If you do not agree, please do not use the App and uninstall it.',
      'We may update these Terms from time to time. When we do, the App will ask you to review and accept the new version.',
    ],
  },
  {
    h: 'Who may use the App',
    p: [
      'You must be at least 18 years old (or the age of majority where you live) and legally able to enter into a binding agreement. If you use the App for a business, you confirm that you are authorised to act for that business.',
    ],
  },
  {
    h: 'Your data stays on your device',
    p: [
      'The App has no user accounts and no developer servers. Your shop profile, bills, customers, items, payments and settings are stored only in the App\'s storage on your phone.',
      'We do not collect, receive, sell or share this data, and this version of the App contains no advertising or analytics. Data leaves your device only when you choose to share, print, export or back it up.',
      'Because the data is local, uninstalling the App, clearing its data, or losing or resetting your phone can permanently delete it. We cannot recover it for you.',
    ],
  },
  {
    h: 'Invoices, GST and tax compliance',
    p: [
      'The App is a record-keeping and document tool. It calculates totals, discounts, round-off and GST from the rates and values you enter. It does not check that those values, your GSTIN, HSN/SAC codes or place-of-supply choices are correct.',
      'You are solely responsible for the accuracy and legality of every document you create, for issuing invoices that meet the GST and other laws that apply to you, and for filing returns, e-invoicing, e-way bills and any other compliance. The App does not connect to the GST portal or to any government system.',
      'Reports and CSV exports are summaries for your convenience and are not a substitute for professional accounting. Nothing in the App is tax, legal or accounting advice. Please consult a qualified professional.',
    ],
  },
  {
    h: 'UPI QR codes and payments',
    p: [
      'If you enter a UPI ID, the App can show a UPI payment QR code and print it on your bills. The App does not process, hold or verify payments, and it cannot confirm that a customer has paid.',
      'You must make sure your UPI ID is correct before sharing any bill. Customers should also check the payee name shown in their payment app before paying. Payments are made directly between your customer and you through their UPI app and bank. We are not a party to any transaction and are not responsible for failed, delayed, misdirected or disputed payments.',
      'Payments you receive must be recorded in the App by you. The balances shown depend entirely on what you record.',
    ],
  },
  {
    h: 'PIN lock and device security',
    p: [
      'The App lets you set a PIN. The PIN is stored, hashed, in your device\'s secure storage (Keychain on iOS, Keystore-backed storage on Android). It is not saved in your backups. The App locks when opened and again after it has been in the background for a short while, and repeated wrong attempts cause a waiting period.',
      'A PIN is a convenience lock, not a guarantee of security. Protect your phone with a screen lock, keep your operating system up to date, and do not use the App on a rooted or jailbroken device.',
      'If you forget your PIN, we cannot reset it. You may have to clear the App\'s data or reinstall it, which deletes everything stored in the App unless you have a backup.',
    ],
  },
  {
    h: 'Backup and restore',
    p: [
      'Backups are your responsibility. The App creates a backup as plain, unencrypted text that you save or share yourself. It contains your business and bank details, your customers\' names and phone numbers, and all your bills. Store it only somewhere private and trusted, and delete copies you no longer need.',
      'Restore only backups that you created yourself, and never paste a backup that someone else sent you. A restore adds or overwrites records that have the same ID and can change your payment details. The App will show you any change to your UPI or bank details and ask you to confirm before it applies them.',
      'The App\'s PIN does not protect backup text once it has left the App.',
    ],
  },
  {
    h: 'Sharing, printing and third-party services',
    p: [
      'The App uses your phone\'s share, print and messaging features, such as WhatsApp, email, cloud storage and print services. When you use them, your content goes to those services and is governed by their own terms and privacy policies. We do not control them and are not responsible for them.',
      'You are responsible for checking the recipient and phone number before you send a bill or a payment reminder.',
    ],
  },
  {
    h: 'Customer information and privacy laws',
    p: [
      'You may store your customers\' names, phone numbers, addresses and GSTINs in the App. You decide what to collect and why. You are responsible for handling that information lawfully, including giving any notices and obtaining any consents required by applicable privacy and data protection laws (such as India\'s Digital Personal Data Protection Act, 2023), and for using it only for your business dealings with that customer.',
    ],
  },
  {
    h: 'Acceptable use',
    p: [
      'You agree not to use the App to create false, misleading or fraudulent documents, to evade tax, to impersonate another person or business, to harass anyone through reminders or messages, or to break any law. You also agree not to copy, reverse engineer or tamper with the App except as the law allows.',
    ],
  },
  {
    h: 'Ownership',
    p: [
      'The App, its design, name and original content belong to the developer. The App also uses third-party open-source software, which remains under its own licences. Your business data and the documents you create remain yours.',
    ],
  },
  {
    h: 'Availability, updates and changes',
    p: [
      'The App may change, be updated or be discontinued at any time without notice. We do not guarantee that it will always be available, free of errors or compatible with every device. Keeping the App up to date is your responsibility.',
    ],
  },
  {
    h: 'Disclaimer of warranties',
    p: [
      'To the fullest extent permitted by law, the App is provided "as is" and "as available", without warranties of any kind, whether express or implied. This includes any warranty about the accuracy of calculations, fitness for a particular purpose, uninterrupted operation, or freedom from errors and security vulnerabilities.',
    ],
  },
  {
    h: 'Limitation of liability',
    p: [
      'To the fullest extent permitted by law, the developer will not be liable for any indirect, incidental, special or consequential loss; for loss of profit, revenue, data or business; for tax, penalties, interest or fines; or for payments that are lost or misdirected, arising from your use of the App or your inability to use it.',
      'Where liability cannot be excluded, our total liability is limited to the amount you paid for the App, or INR 1,000 if you paid nothing. Nothing in these Terms limits any liability that cannot be limited by law.',
    ],
  },
  {
    h: 'Ending your use',
    p: [
      'You may stop using the App at any time by uninstalling it, which removes the data stored in it. We may suspend or end your access if you breach these Terms. Sections that by their nature should continue (such as the disclaimers, the limit of liability and the governing law) remain in effect after you stop using the App.',
    ],
  },
  {
    h: 'Governing law and disputes',
    p: [
      'These Terms are governed by the laws of India. Subject to applicable law, the courts at [your city, state], India have exclusive jurisdiction over any dispute arising from these Terms or the App.',
    ],
  },
  {
    h: 'Contact',
    p: [
      'For questions about these Terms, contact us at [your contact email].',
    ],
  },
];
