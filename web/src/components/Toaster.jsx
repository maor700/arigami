// The toast stack now lives in ui/toast.jsx (same store, same behaviour);
// kept as a module so App.jsx's import does not change.
import { Toaster } from './ui/toast.jsx';

export default Toaster;
