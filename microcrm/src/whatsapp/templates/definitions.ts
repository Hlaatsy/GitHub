// Templates the app sends, written once and submitted to Meta per WABA.
//
// `params` names what the code fills into {{1}}..{{n}}, in order. The tests
// check these against what the senders actually pass, so a template and its
// sender cannot drift apart.

export type TemplateCategory = 'UTILITY' | 'MARKETING';

export type TemplateButton =
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'PHONE_NUMBER'; text: string; phoneNumber: string };

export interface TemplateDefinition {
  name: string;
  language: string;
  category: TemplateCategory;
  header?: { text: string; example?: string };
  body: { text: string; params: readonly string[]; examples: readonly string[] };
  footer?: string;
  buttons?: readonly TemplateButton[];
}

/** Core templates, parameterised by the public origin their URL button points at. */
export function coreTemplates(publicOrigin: string, language: string): TemplateDefinition[] {
  return [
    {
      name: 'payment_request',
      language,
      category: 'UTILITY',
      body: {
        text: 'Hi! {{1}} is holding {{2}} for you. Pay {{3}} to confirm it. This link is valid until {{4}}.',
        params: ['businessName', 'summary', 'amount', 'expiresAt'],
        examples: ['Glow Studio', 'Wash & Blow on Mon 12 Oct at 09:00', 'R125.00', '09:30'],
      },
      footer: 'Secure online payment',
      buttons: [
        {
          type: 'URL',
          text: 'Pay now',
          url: `${publicOrigin}/pay/{{1}}`,
          example: `${publicOrigin}/pay/h1sqQBba0kSu2ElkZDoCEt5BMkBmPw7E`,
        },
      ],
    },
    {
      name: 'payment_confirmed',
      language,
      category: 'UTILITY',
      body: {
        text: 'Payment received. {{1}} has confirmed {{2}}. Amount paid: {{3}}. Reference: {{4}}.',
        params: ['businessName', 'summary', 'amount', 'reference'],
        examples: ['Glow Studio', 'Wash & Blow on Mon 12 Oct at 09:00', 'R125.00', 'WA3APVXKEKRB'],
      },
    },
    {
      name: 'wallet_low_balance',
      language,
      category: 'UTILITY',
      body: {
        text: 'Heads up: the WhatsApp message wallet for {{1}} is at {{2}}, below your {{3}} minimum. Top up to keep replies going out.',
        params: ['businessName', 'balance', 'threshold'],
        examples: ['Glow Studio', 'R9.88', 'R10.00'],
      },
    },
  ];
}
