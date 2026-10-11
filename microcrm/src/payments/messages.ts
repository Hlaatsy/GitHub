import { formatZar } from '../lib/money';
import { formatTime } from '../lib/time';
import { asInteractive, clip, ctaUrl, LIMITS } from '../whatsapp/interactive';
import { type OutboundMessage, type TemplateComponent } from '../whatsapp/types';

export interface PaymentLinkView {
  amountCents: number;
  /** https://<domain>/pay/<token> */
  shortUrl: string;
  linkToken: string;
  expiresAt: Date;
}

export interface PaymentMessageContext {
  businessName: string;
  timeZone: string;
  /** One line, e.g. "Wash & Blow on Mon 12 Oct at 09:00". */
  summary: string;
  templateLanguage: string;
  /** Template whose single URL button is approved as https://<domain>/pay/{{1}}. */
  requestTemplate: string;
}

/**
 * Meta rejects template parameters containing newlines, tabs or more than
 * four consecutive spaces; collapse whitespace and clip before sending.
 */
export function templateParam(value: string): string {
  return clip(value.replace(/\s+/g, ' '), LIMITS.TEMPLATE_PARAM);
}

function templateComponents(body: readonly string[], urlSuffix?: string): TemplateComponent[] {
  const components: TemplateComponent[] = [
    { type: 'body', parameters: body.map((text) => ({ type: 'text', text: templateParam(text) })) },
  ];
  if (urlSuffix) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: urlSuffix }] });
  }
  return components;
}

/**
 * The payment link as one concise message with the URL on a tap-to-pay
 * button, never pasted into the text.
 *
 * Inside the 24h customer service window (the normal case: the customer just
 * picked a slot) it is a free-form `cta_url` interactive, which needs no
 * template approval and is billed as a service message. Outside the window it
 * falls back to the approved utility template, whose URL button carries the
 * link token as its dynamic suffix.
 */
export function formatPaymentLinkMessage(
  link: PaymentLinkView,
  ctx: PaymentMessageContext,
  { inServiceWindow }: { inServiceWindow: boolean },
): OutboundMessage {
  const amount = formatZar(link.amountCents);
  const expires = formatTime(link.expiresAt, ctx.timeZone);

  if (inServiceWindow) {
    return asInteractive(
      ctaUrl({
        body: `${ctx.summary}\nPay ${amount} to lock it in. Instant EFT or PayShap from your banking app.`,
        footer: `Link valid until ${expires}`,
        displayText: `Pay ${amount}`,
        url: link.shortUrl,
      }),
    );
  }

  return {
    type: 'template',
    template: {
      name: ctx.requestTemplate,
      language: { code: ctx.templateLanguage },
      components: templateComponents([ctx.businessName, ctx.summary, amount, expires], link.linkToken),
    },
  };
}

/** Single confirmation template sent once the bank settlement is verified. */
export function formatPaymentConfirmedTemplate(
  templateName: string,
  languageCode: string,
  params: { businessName: string; summary: string; amountCents: number; reference: string },
): OutboundMessage {
  return {
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: templateComponents([params.businessName, params.summary, formatZar(params.amountCents), params.reference]),
    },
  };
}
