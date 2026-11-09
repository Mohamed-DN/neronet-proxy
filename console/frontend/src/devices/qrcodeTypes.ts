/*
 * The qrcode package ships without types and the plan adds no @types package.
 * This declares only the one function the console calls.
 */
declare module 'qrcode' {
  export interface QrCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
  }
  const QRCode: {
    toDataURL(text: string, options?: QrCodeOptions): Promise<string>;
  };
  export default QRCode;
}
