export async function verifyQuickBooksWebhook(payload: string, signatureHeader: string, verifierToken: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  const computedSignatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return timingSafeEqual(computedSignatureBase64, signatureHeader);
}

export async function verifyXeroWebhook(payload: string, signatureHeader: string, webhookKey: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  const computedSignatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return timingSafeEqual(computedSignatureBase64, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function parseQuickBooksInvoiceUpdate(payload: string): { id: string; status: string }[] {
  try {
    const data = JSON.parse(payload);
    const updates: { id: string; status: string }[] = [];
    if (data.eventNotifications) {
      for (const notification of data.eventNotifications) {
        if (notification.dataChangeEvent?.entities) {
          for (const entity of notification.dataChangeEvent.entities) {
            if (entity.name === 'Invoice') {
              updates.push({ id: entity.id, status: entity.operation === 'Update' ? 'updated' : 'created' });
            }
          }
        }
      }
    }
    return updates;
  } catch (e) {
    return [];
  }
}

export function parseXeroInvoiceUpdate(payload: string): { id: string; eventType: string }[] {
  try {
    const data = JSON.parse(payload);
    const updates: { id: string; eventType: string }[] = [];
    if (data.events) {
      for (const event of data.events) {
        if (event.eventCategory === 'INVOICE') {
          updates.push({ id: event.resourceId, eventType: event.eventType });
        }
      }
    }
    return updates;
  } catch (e) {
    return [];
  }
}
