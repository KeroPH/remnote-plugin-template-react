import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import '../style.css';

async function onActivate(plugin: ReactRNPlugin) {
  // Register the Selected Text widget
  await plugin.app.registerWidget(
    'selected_cloze',
    WidgetLocation.SelectedTextMenu,
    {
      dimensions: { height: 'auto', width: '100%' },
      widgetTabIcon: 'https://cdn-icons-png.flaticon.com/512/164/164615.png',
      widgetTabTitle: 'AutoCloze',
    }
  );
  await plugin.app.registerWidget(
    'autocloze_sidebar',
    WidgetLocation.SidebarEnd,
    {
      dimensions: { height: 'auto', width: 'auto' },
      widgetTabTitle: 'AutoCloze',
    }
  );

  // Settings (API Key + max clozes)
  await plugin.settings.registerStringSetting({
    id: 'openai_api_key',
    title: 'OpenAI API Key',
    description: 'Paste your OpenAI API key here.',
  });

  await plugin.settings.registerNumberSetting({
    id: 'max_clozes',
    title: 'Max Clozes',
    description: 'Maximum number of cloze deletions to generate.',
    defaultValue: 3,
  });
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
