import { mountLocaleSwitch } from '../i18n';
import { localizeSiteLinks } from './feedback';
import { mountProductStatus } from './productStatus';

// The guide is static markup; i18n translates it on load, and this wires the language switch and the site links.
mountLocaleSwitch(document.querySelector<HTMLButtonElement>('#locale-switch')!);
localizeSiteLinks();
const status = document.getElementById('service-status');
if (status) mountProductStatus(status);
