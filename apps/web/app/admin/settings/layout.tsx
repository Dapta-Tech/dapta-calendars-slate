import type { ReactNode } from 'react';
import { SettingsChrome } from './settings-chrome';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsChrome>{children}</SettingsChrome>;
}
