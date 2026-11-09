import { createElement, render } from 'preact';
import { ResearchApp } from './researchViews';

const root = document.getElementById('research-root');
if (root) render(createElement(ResearchApp, {}), root);
