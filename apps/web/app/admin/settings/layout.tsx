import type { ReactNode } from 'react';
import { getMessages } from '@slate/shared';
import { getLocale } from '@/lib/locale';
import { SettingsChrome } from './settings-chrome';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const messages = getMessages(await getLocale()).admin.settings;
  return <SettingsChrome messages={messages}>{children}</SettingsChrome>;
}
