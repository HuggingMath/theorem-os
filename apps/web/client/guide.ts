import { mountLocaleSwitch } from '../i18n';
import { localizeSiteLinks } from './feedback';

// The guide is static markup; i18n translates it on load, and this wires the language switch and the site links.
mountLocaleSwitch(document.querySelector<HTMLButtonElement>('#locale-switch')!);
localizeSiteLinks();
