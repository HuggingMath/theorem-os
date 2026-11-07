import { mountLocaleSwitch } from '../i18n';
import { localizeSiteLinks } from './feedback';

// The terms and privacy pages are static markup; i18n translates them on load, and this wires the switch and site links.
mountLocaleSwitch(document.querySelector<HTMLButtonElement>('#locale-switch')!);
localizeSiteLinks();
