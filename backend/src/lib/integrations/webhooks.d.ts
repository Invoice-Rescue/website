export declare function verifyQuickBooksWebhook(payload: string, signatureHeader: string, verifierToken: string): Promise<boolean>;
export declare function verifyXeroWebhook(payload: string, signatureHeader: string, webhookKey: string): Promise<boolean>;
export declare function parseQuickBooksInvoiceUpdate(payload: string): {
    id: string;
    status: string;
}[];
export declare function parseXeroInvoiceUpdate(payload: string): {
    id: string;
    eventType: string;
}[];
