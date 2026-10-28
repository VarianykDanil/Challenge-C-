/**
 * Imported first by the commands run by hand (doctor, backup, restore, key:restore, recovery-sheet), so that from a
 * plain terminal they use the database, folders and key of the installed background service (useServiceSettings).
 */
import { useServiceSettings } from './service.ts';

const took = useServiceSettings();
if (took.length) console.log(`Linear Hub: using the background service's settings for ${took.join(', ')} (this terminal does not set them).`);
