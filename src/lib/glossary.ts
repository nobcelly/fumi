// Official terms that turn up in letters to residents of Japan, with plain
// meanings. This is the built-in copy; Remote Config can replace it.
export type Term = { ja: string; en: string };

export const GLOSSARY: Term[] = [
  { ja: '住民税（市民税・県民税・特別区民税）', en: 'Resident tax: local income tax paid to your city and prefecture, based on last year\'s income. Bills usually come in June and are paid in four instalments (June, August, October, January).' },
  { ja: '納税通知書', en: 'Tax payment notice: a bill. It tells you how much tax to pay and by when.' },
  { ja: '納期限', en: 'Payment deadline. Paying late adds a late fee (延滞金).' },
  { ja: '納付書', en: 'Payment slip. You can pay it at a bank, post office or convenience store (if it has a barcode), or with some smartphone payment apps.' },
  { ja: '国民健康保険（国保）', en: 'National Health Insurance: public health insurance for people who are not covered by an employer. Premiums are billed by your city.' },
  { ja: '国民年金', en: 'National Pension: public pension that residents aged 20–59 must join. Students and low-income people can apply for an exemption or postponement (免除・猶予).' },
  { ja: '督促状', en: 'Reminder notice: a payment was missed. Pay quickly or contact the office; continued non-payment can lead to seizure of assets (差押え).' },
  { ja: '在留カード', en: 'Residence card: your ID as a foreign resident. Bring it to the city office.' },
  { ja: 'マイナンバー（個人番号）', en: 'My Number: your 12-digit personal number for tax and social security. Do not share it unless an office asks for it.' },
  { ja: '口座振替', en: 'Direct debit: the payment is taken automatically from your bank account.' },
  { ja: '還付', en: 'Refund: money paid back to you.' },
  { ja: '申告', en: 'Declaration / filing: you must report information (for example income) to the office.' },
  { ja: '窓口', en: 'Service counter at the office.' },
  { ja: '期別', en: 'Instalment number (for example 第2期 = second instalment).' },
  { ja: '延滞金', en: 'Late fee added when you pay after the deadline.' },
  { ja: '転入届・転出届', en: 'Moving-in / moving-out notification: tell the city office within 14 days when you move.' },
];
