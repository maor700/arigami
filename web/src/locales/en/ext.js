// EXT — Settings › Extensions, the "+" tab popover rows, the composer's
// extension slash commands, and the `ext-card` chat card.
export const strings = {
  'ext.title': 'Extensions',
  'ext.sub': 'Directories you install yourself. An extension can add tools, a skill, a listener, hooks and a tab — and it runs with this host’s privileges.',
  'ext.empty': 'No extension installed. Add one from a directory or a git URL.',
  'ext.reload': 'Reload',
  'ext.reloading': 'Reloading…',
  'ext.reloaded': 'Extensions reloaded',
  'ext.apiVersion': 'API v{n}',

  // state
  'ext.state.loaded': 'Active',
  'ext.state.disabled': 'Off',
  'ext.state.error': 'Error',

  // the card
  'ext.version': 'v{v}',
  'ext.sha': 'commit {sha}',
  'ext.enable': 'Enable',
  'ext.permissions': 'Permissions',
  'ext.permissions.none': 'Asks for nothing',
  'ext.contributions': 'Contributes',
  'ext.c.tools': '{n} tools',
  'ext.c.listeners': '{n} listeners',
  'ext.c.docs': '{n} skills',
  'ext.c.tabs': '{n} tabs',
  'ext.c.hooks': '{n} hooks',
  'ext.c.gates': '{n} gates',
  'ext.c.channels': '{n} channels',
  'ext.c.webhooks': '{n} webhooks',
  'ext.c.none': 'nothing yet',
  'ext.warnings': 'Warnings',

  // settings form
  'ext.settings': 'Settings',
  'ext.settings.save': 'Save',
  'ext.settings.saving': 'Saving…',
  'ext.settings.saved': 'Settings saved',
  'ext.settings.default': 'default: {v}',

  // remove
  'ext.remove': 'Remove',
  'ext.remove.title': 'Remove “{name}”?',
  'ext.remove.body': 'The directory is deleted. Its settings are kept, so reinstalling restores them.',
  'ext.remove.confirm': 'Remove',
  'ext.removed': '“{name}” removed',

  // add
  'ext.add': 'Add an extension',
  'ext.add.hint': 'A directory on this host, or a git URL to shallow-clone.',
  'ext.add.placeholder': '~/my-extension  ·  https://github.com/…/ext.git',
  'ext.add.check': 'Continue',
  'ext.add.checking': 'Reading the manifest…',
  'ext.add.installing': 'Installing…',
  'ext.added': '“{name}” installed',

  // the permissions confirmation, shown BEFORE anything is installed
  'ext.confirm.title': 'Install “{name}”?',
  'ext.confirm.intro': 'Extension code runs inside the host, with its privileges. It asks for:',
  'ext.confirm.install': 'Install',
  'ext.confirm.cancel': 'Cancel',
  'ext.confirm.errors': 'This extension does not validate. Installing it will leave it in an error state.',
  'ext.confirm.git.title': 'Clone and install from git?',
  'ext.confirm.git.body': 'The manifest can only be read after the clone, so its permissions are shown once the code is already on this host. Clone only from a source you trust.',
  'ext.confirm.git.go': 'Clone and install',
  'ext.review.title': '“{name}” is installed — review its permissions',
  'ext.review.intro': 'It is active now. Keep it, or turn it off until you have read the code.',
  'ext.review.keep': 'Keep it on',
  'ext.review.disable': 'Turn off',
  'ext.review.remove': 'Remove',

  // permission labels
  'ext.perm.session:message': 'Send messages to the session',
  'ext.perm.session:prompts': 'Queue prompts for the session',
  'ext.perm.session:tabs': 'Open, update and close tabs',
  'ext.perm.session:artifacts': 'Publish artifacts',
  'ext.perm.session:listeners': 'Arm listeners',
  'ext.perm.notify': 'Send notifications',
  'ext.perm.tools': 'Call its own tool “{name}”',
  'ext.perm.events': 'Watch host events “{name}”',
  'ext.perm.unknown': 'Unknown permission — grants nothing',

  // tab bar + slash
  'ext.tabs.heading': 'Extensions',
  'ext.slashDesc': 'open “{tab}” ({ext})',

  // chat card
  'ext.card.from': 'extension',
};
