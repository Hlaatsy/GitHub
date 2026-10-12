import { type TemplateDefinition } from './definitions';

// Local checks for the rules Meta enforces at review, so a template is fixed
// before it spends days in the queue or gets rejected. Meta has further
// judgement-based rules (e.g. too many variables for the text length,
// marketing content in a utility template) that only review can catch.

const PLACEHOLDER = /\{\{(\d+)\}\}/g;

const LIMITS = {
  NAME: 512,
  HEADER: 60,
  BODY: 1024,
  FOOTER: 60,
  BUTTON_TEXT: 25,
  BUTTONS: 10,
  URL_BUTTONS: 2,
  PHONE_BUTTONS: 1,
} as const;

function placeholders(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => Number(match[1]));
}

function checkSequence(where: string, text: string, problems: string[]): number {
  const found = placeholders(text);
  found.forEach((value, index) => {
    if (value !== index + 1) problems.push(`${where}: placeholders must run {{1}}, {{2}}, … in order (found {{${value}}} at position ${index + 1})`);
  });
  if (/\{\{(?!\d+\}\})|(?<!\{\{\d+)\}\}/.test(text)) problems.push(`${where}: malformed placeholder braces`);
  return found.length;
}

/** Returns every problem found; an empty list means the template is ready to submit. */
export function validateTemplate(def: TemplateDefinition): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9_]+$/.test(def.name) || def.name.length > LIMITS.NAME) {
    problems.push('name: lowercase letters, digits and underscores only');
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(def.language)) problems.push(`language: "${def.language}" is not a locale code like en or en_US`);

  // Header
  if (def.header) {
    if (def.header.text.length > LIMITS.HEADER) problems.push(`header: over ${LIMITS.HEADER} characters`);
    const count = checkSequence('header', def.header.text, problems);
    if (count > 1) problems.push('header: at most one placeholder');
    if (count === 1 && !def.header.example) problems.push('header: needs an example value for {{1}}');
  }

  // Body
  const body = def.body.text;
  if (body.trim().length === 0) problems.push('body: required');
  if (body.length > LIMITS.BODY) problems.push(`body: over ${LIMITS.BODY} characters`);
  const count = checkSequence('body', body, problems);
  if (/^\s*\{\{\d+\}\}/.test(body)) problems.push('body: cannot start with a placeholder');
  if (/\{\{\d+\}\}\s*$/.test(body)) problems.push('body: cannot end with a placeholder');
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) problems.push('body: placeholders need text between them');
  if (def.body.params.length !== count) problems.push(`body: ${count} placeholders but ${def.body.params.length} params mapped`);
  if (def.body.examples.length !== count) problems.push(`body: ${count} placeholders but ${def.body.examples.length} examples`);
  def.body.examples.forEach((example, index) => {
    if (!example.trim() || /[\n\t]| {5,}/.test(example)) problems.push(`body: example ${index + 1} must be one line of text`);
  });

  // Footer
  if (def.footer !== undefined) {
    if (def.footer.length > LIMITS.FOOTER) problems.push(`footer: over ${LIMITS.FOOTER} characters`);
    if (placeholders(def.footer).length > 0) problems.push('footer: placeholders are not allowed');
  }

  // Buttons
  const buttons = def.buttons ?? [];
  if (buttons.length > LIMITS.BUTTONS) problems.push(`buttons: at most ${LIMITS.BUTTONS}`);
  if (buttons.filter((b) => b.type === 'URL').length > LIMITS.URL_BUTTONS) problems.push(`buttons: at most ${LIMITS.URL_BUTTONS} URL buttons`);
  if (buttons.filter((b) => b.type === 'PHONE_NUMBER').length > LIMITS.PHONE_BUTTONS) problems.push('buttons: at most one phone button');
  buttons.forEach((button, index) => {
    const where = `button ${index + 1}`;
    if (button.text.length === 0 || button.text.length > LIMITS.BUTTON_TEXT) problems.push(`${where}: text must be 1-${LIMITS.BUTTON_TEXT} characters`);
    if (placeholders(button.text).length > 0) problems.push(`${where}: text cannot contain placeholders`);
    if (button.type === 'URL') {
      const vars = placeholders(button.url);
      if (!button.url.startsWith('https://')) problems.push(`${where}: URL must be https`);
      if (vars.length > 1 || (vars.length === 1 && !button.url.endsWith('{{1}}'))) {
        problems.push(`${where}: only one placeholder, {{1}}, at the very end of the URL`);
      }
      if (vars.length === 1) {
        const base = button.url.slice(0, -'{{1}}'.length);
        if (!button.example?.startsWith(base) || button.example.length <= base.length) {
          problems.push(`${where}: example must be a full URL starting with ${base}`);
        }
      }
    }
    if (button.type === 'PHONE_NUMBER' && !/^\+\d{8,15}$/.test(button.phoneNumber)) {
      problems.push(`${where}: phone number must be in +E.164 format`);
    }
  });

  return problems;
}

/** Meta's message_templates request body for a definition. */
export function toGraphTemplate(def: TemplateDefinition): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  if (def.header) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: def.header.text,
      ...(def.header.example ? { example: { header_text: [def.header.example] } } : {}),
    });
  }
  components.push({
    type: 'BODY',
    text: def.body.text,
    ...(def.body.examples.length > 0 ? { example: { body_text: [def.body.examples] } } : {}),
  });
  if (def.footer) components.push({ type: 'FOOTER', text: def.footer });
  if (def.buttons?.length) {
    components.push({
      type: 'BUTTONS',
      buttons: def.buttons.map((button) => {
        switch (button.type) {
          case 'URL':
            return { type: 'URL', text: button.text, url: button.url, ...(button.example ? { example: [button.example] } : {}) };
          case 'QUICK_REPLY':
            return { type: 'QUICK_REPLY', text: button.text };
          case 'PHONE_NUMBER':
            return { type: 'PHONE_NUMBER', text: button.text, phone_number: button.phoneNumber };
        }
      }),
    });
  }
  return { name: def.name, language: def.language, category: def.category, components };
}
