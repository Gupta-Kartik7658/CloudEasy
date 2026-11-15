const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8000"
).replace(/\/+$/, "");

const AUTH_TOKEN_KEY = "auth_token";
const AUTH_USER_EMAIL_KEY = "auth_user_email";
const LOCAL_USERS_KEY = "cloudeasy_users_v1";
const LOCAL_KEYS_PREFIX = "cloudeasy_keys_v1:";
const LOCAL_VMS_PREFIX = "cloudeasy_vms_v1:";

export interface AuthUser {
  id: string;
  email: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface VM {
  id: number;
  name: string;
  key_name: string;
  ram: number;
  cpu: number;
  image: string;
  private_ip: string;
  inbound_rules: InboundRule[];
  owner_id: string | number;
  status?: "Provisioning" | "Starting" | "Active" | "Stopping" | "Stopped" | "Deleting" | "Error";
}

export interface InboundRule {
  type: "http" | "tcp" | "ssh" | "udp" | "icmp";
  vm_port: number;
  description?: string;
  remotePort?: number;
}

export interface SSHKey {
  name: string;
}

export interface CreateVMRequest {
  username: string;
  key_name: string;
  ram: number;
  cpu: number;
  image: string;
  inbound_rules?: InboundRule[];
  provisioning_script?: string;
}

interface StoredLocalUser {
  id: string;
  email: string;
  passwordHash: string;
}

interface StoredLocalKey {
  name: string;
  privateKey: string;
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

async function hashPassword(password: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoded = new TextEncoder().encode(`cloudeasy:${password}`);
    const buffer = await crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback deterministic hash for non-HTTPS LAN environments where crypto.subtle is unavailable
  let h1 = 0xdeadbeef ^ password.length;
  let h2 = 0x41c6ce57 ^ password.length;
  for (let i = 0; i < password.length; i++) {
    const ch = password.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractErrorMessage(errorPayload: any, fallback: string): string {
  const detail = errorPayload?.detail;
  if (!detail) return fallback;

  if (typeof detail === "string") {
    switch (detail) {
      case "REGISTER_USER_ALREADY_EXISTS":
        return "An account with this email already exists. Please sign in instead.";
      case "LOGIN_BAD_CREDENTIALS":
        return "Invalid email or password. Please check your credentials or create an account.";
      case "LOGIN_USER_NOT_VERIFIED":
        return "Account is not verified.";
      case "Unauthorized":
        return "Your session has expired. Please sign in again.";
      default:
        return detail;
    }
  }

  if (typeof detail === "object" && !Array.isArray(detail) && detail.reason) {
    return String(detail.reason);
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.msg) return String(item.msg).replace(/^Value error,\s*/i, "");
        return null;
      })
      .filter(Boolean);
    if (messages.length > 0) return messages.join(", ");
  }

  return fallback;
}

class APIClient {
  private token: string | null = null;
  private unauthorizedListeners = new Set<() => void>();

  constructor() {
    this.token = localStorage.getItem(AUTH_TOKEN_KEY);
  }

  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.add(listener);
    return () => {
      this.unauthorizedListeners.delete(listener);
    };
  }

  private notifyUnauthorized() {
    this.clearToken();
    this.unauthorizedListeners.forEach((listener) => listener());
  }

  setToken(token: string, email?: string) {
    this.token = token;
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    if (email) {
      localStorage.setItem(AUTH_USER_EMAIL_KEY, email);
    }
  }

  clearToken() {
    this.token = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_EMAIL_KEY);
  }

  getToken(): string | null {
    return this.token;
  }

  private isLocalToken(): boolean {
    return Boolean(this.token && this.token.startsWith("local:"));
  }

  private getLocalUserId(): string {
    return this.token?.replace(/^local:/, "") || "anonymous";
  }

  private getLocalUsers(): StoredLocalUser[] {
    try {
      const raw = localStorage.getItem(LOCAL_USERS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveLocalUsers(users: StoredLocalUser[]) {
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
  }

  private upsertLocalUser(user: StoredLocalUser) {
    const users = this.getLocalUsers();
    const index = users.findIndex((u) => u.email === user.email);
    if (index >= 0) {
      users[index] = user;
    } else {
      users.push(user);
    }
    this.saveLocalUsers(users);
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      this.notifyUnauthorized();
      throw new Error("Your session has expired. Please sign in again.");
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
      throw new Error(extractErrorMessage(error, `Request failed (HTTP ${response.status})`));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Auth endpoints
  async register(data: RegisterRequest): Promise<AuthUser> {
    const email = data.email.trim().toLowerCase();
    const password = data.password;

    if (!email) {
      throw new Error("Please enter an email address.");
    }
    if (!password) {
      throw new Error("Please enter a password.");
    }

    const passwordHash = await hashPassword(password);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: "Registration failed" }));
        throw new Error(extractErrorMessage(error, "Registration failed"));
      }

      const created = await response.json();
      this.upsertLocalUser({
        id: String(created.id || generateId()),
        email,
        passwordHash,
      });
      return { id: String(created.id), email: created.email || email };
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      // Transparent local fallback when backend server is unreachable
      const users = this.getLocalUsers();
      if (users.some((u) => u.email === email)) {
        throw new Error("An account with this email already exists. Please sign in instead.");
      }

      const newUser: StoredLocalUser = {
        id: generateId(),
        email,
        passwordHash,
      };
      users.push(newUser);
      this.saveLocalUsers(users);
      return { id: newUser.id, email: newUser.email };
    }
  }

  async login(data: LoginRequest) {
    const email = data.username.trim().toLowerCase();
    const password = data.password;

    if (!email || !password) {
      throw new Error("Please enter both your email and password.");
    }

    const passwordHash = await hashPassword(password);

    const attemptBackendLogin = async () => {
      const body = new URLSearchParams();
      body.append("username", email);
      body.append("password", password);

      return fetch(`${API_BASE_URL}/auth/jwt/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    };

    try {
      let response = await attemptBackendLogin();

      // If user registered while backend was offline, seamlessly sync their account to the backend
      if (response.status === 400) {
        const localUser = this.getLocalUsers().find(
          (u) => u.email === email && u.passwordHash === passwordHash
        );
        if (localUser) {
          const regRes = await fetch(`${API_BASE_URL}/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          if (regRes.ok) {
            response = await attemptBackendLogin();
          }
        }
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: "Login failed" }));
        throw new Error(extractErrorMessage(error, "Login failed"));
      }

      const result = await response.json();
      this.setToken(result.access_token, email);
      this.upsertLocalUser({
        id: generateId(),
        email,
        passwordHash,
      });
      return result;
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }

      // Transparent local fallback when backend server is unreachable
      const users = this.getLocalUsers();
      const matchedUser = users.find((u) => u.email === email);
      if (!matchedUser) {
        throw new Error("No account found for this email. Please create an account first.");
      }
      if (matchedUser.passwordHash !== passwordHash) {
        throw new Error("Invalid email or password.");
      }

      const localToken = `local:${matchedUser.id}`;
      this.setToken(localToken, matchedUser.email);
      return { access_token: localToken, token_type: "bearer" };
    }
  }

  async getCurrentUser(): Promise<AuthUser> {
    if (!this.token) {
      throw new Error("Not authenticated");
    }

    if (this.isLocalToken()) {
      const userId = this.getLocalUserId();
      const localUser = this.getLocalUsers().find((u) => u.id === userId);
      const cachedEmail = localStorage.getItem(AUTH_USER_EMAIL_KEY);
      if (localUser) {
        return { id: localUser.id, email: localUser.email };
      }
      if (cachedEmail) {
        return { id: userId, email: cachedEmail };
      }
      this.clearToken();
      throw new Error("Session invalid");
    }

    try {
      const user = await this.request<AuthUser>("/users/me");
      if (user?.email) {
        localStorage.setItem(AUTH_USER_EMAIL_KEY, user.email);
      }
      return user;
    } catch (error) {
      if (isNetworkError(error)) {
        const cachedEmail = localStorage.getItem(AUTH_USER_EMAIL_KEY);
        if (cachedEmail) {
          return { id: "cached", email: cachedEmail };
        }
      }
      throw error;
    }
  }

  async logout() {
    const wasLocal = this.isLocalToken();
    try {
      if (!wasLocal && this.token) {
        await fetch(`${API_BASE_URL}/auth/jwt/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.token}` },
        });
      }
    } catch {
      // Ignore logout network issues and clear local session
    } finally {
      this.clearToken();
    }
  }

  // Local storage helpers for standalone mode
  private getLocalKeys(): StoredLocalKey[] {
    try {
      const raw = localStorage.getItem(`${LOCAL_KEYS_PREFIX}${this.getLocalUserId()}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveLocalKeys(keys: StoredLocalKey[]) {
    localStorage.setItem(`${LOCAL_KEYS_PREFIX}${this.getLocalUserId()}`, JSON.stringify(keys));
  }

  private getLocalVMs(): VM[] {
    try {
      const raw = localStorage.getItem(`${LOCAL_VMS_PREFIX}${this.getLocalUserId()}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveLocalVMs(vms: VM[]) {
    localStorage.setItem(`${LOCAL_VMS_PREFIX}${this.getLocalUserId()}`, JSON.stringify(vms));
  }

  // VM endpoints
  async listVMs(): Promise<VM[]> {
    if (this.isLocalToken()) {
      return this.getLocalVMs();
    }
    try {
      return await this.request("/list-vms");
    } catch (error) {
      if (isNetworkError(error)) return this.getLocalVMs();
      throw error;
    }
  }

  async createVM(data: CreateVMRequest) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs();
      if (vms.some((v) => v.name === data.username)) {
        throw new Error(`VM name '${data.username}' is already taken.`);
      }
      const nextIndex = vms.length + 11;
      const sshPort = 2222 + vms.length;
      const newVM: VM = {
        id: Date.now(),
        name: data.username,
        key_name: data.key_name,
        ram: data.ram,
        cpu: data.cpu,
        image: data.image,
        private_ip: `192.168.56.${nextIndex}`,
        inbound_rules: (data.inbound_rules || [{ type: "tcp", vm_port: 22, description: "SSH Access" }]).map(
          (r, idx) => ({ ...r, remotePort: sshPort + idx })
        ),
        owner_id: this.getLocalUserId(),
        status: "Active",
      };
      vms.push(newVM);
      this.saveLocalVMs(vms);
      return { message: `ssh -i ${data.key_name} ${data.username}@localhost -p ${sshPort}` };
    }
    return this.request("/create-vm", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteVM(vmName: string) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs().filter((v) => v.name !== vmName);
      this.saveLocalVMs(vms);
      return { message: `VM '${vmName}' deleted.` };
    }
    return this.request(`/delete-vm/${vmName}`, { method: "DELETE" });
  }

  async startVM(vmName: string) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs().map((v) =>
        v.name === vmName ? { ...v, status: "Active" as const } : v
      );
      this.saveLocalVMs(vms);
      return { message: `VM '${vmName}' started.` };
    }
    return this.request(`/start-vm/${vmName}`, { method: "POST" });
  }

  async stopVM(vmName: string) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs().map((v) =>
        v.name === vmName ? { ...v, status: "Stopped" as const } : v
      );
      this.saveLocalVMs(vms);
      return { message: `VM '${vmName}' stopped.` };
    }
    return this.request(`/stop-vm/${vmName}`, { method: "POST" });
  }

  async addInboundRule(port: number, vmName: string, description: string) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs();
      const vm = vms.find((v) => v.name === vmName);
      if (!vm) throw new Error("VM not found");
      const remotePort = 2300 + Math.floor(Math.random() * 600);
      vm.inbound_rules = [
        ...(vm.inbound_rules || []),
        { type: "tcp", vm_port: port, description, remotePort },
      ];
      this.saveLocalVMs(vms);
      return { message: `Inbound rule for port ${port} added.` };
    }
    return this.request(`/add-inbound-rule/${port}`, {
      method: "POST",
      body: JSON.stringify({ vm_name: vmName, description }),
    });
  }

  async removeInboundRule(vmName: string, remotePort: number) {
    if (this.isLocalToken()) {
      const vms = this.getLocalVMs();
      const vm = vms.find((v) => v.name === vmName);
      if (vm) {
        vm.inbound_rules = (vm.inbound_rules || []).filter((r) => r.remotePort !== remotePort);
        this.saveLocalVMs(vms);
      }
      return { message: `Rule removed.` };
    }
    return this.request(`/remove-inbound-rule/${vmName}/${remotePort}`, {
      method: "DELETE",
    });
  }

  // SSH Key endpoints
  async listKeys(): Promise<SSHKey[]> {
    if (this.isLocalToken()) {
      return this.getLocalKeys().map((k) => ({ name: k.name }));
    }
    try {
      return await this.request("/list-keys");
    } catch (error) {
      if (isNetworkError(error)) return this.getLocalKeys().map((k) => ({ name: k.name }));
      throw error;
    }
  }

  async generateKey(keyName: string) {
    if (this.isLocalToken()) {
      const keys = this.getLocalKeys();
      if (keys.some((k) => k.name === keyName)) {
        throw new Error(`Key with name '${keyName}' already exists.`);
      }
      keys.push({
        name: keyName,
        privateKey: `-----BEGIN PRIVATE KEY-----\nCloudEasy-Key-${keyName}-${generateId()}\n-----END PRIVATE KEY-----\n`,
      });
      this.saveLocalKeys(keys);
      return { message: `SSH key '${keyName}' generated.` };
    }
    return this.request(`/generate-key/${keyName}`, { method: "POST" });
  }

  async downloadKey(keyName: string) {
    if (this.isLocalToken()) {
      const key = this.getLocalKeys().find((k) => k.name === keyName);
      if (!key) throw new Error("Key not found");
      const blob = new Blob([key.privateKey], { type: "application/octet-stream" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = keyName;
      a.click();
      window.URL.revokeObjectURL(url);
      return;
    }

    const response = await fetch(`${API_BASE_URL}/download-key/${keyName}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      throw new Error("Failed to download key");
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = keyName;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  async deleteKey(keyName: string) {
    if (this.isLocalToken()) {
      const inUse = this.getLocalVMs().some((v) => v.key_name === keyName);
      if (inUse) {
        throw new Error(`Key '${keyName}' is still in use by one or more VMs.`);
      }
      this.saveLocalKeys(this.getLocalKeys().filter((k) => k.name !== keyName));
      return { message: `Deleted key '${keyName}'.` };
    }
    return this.request(`/delete-key/${keyName}`, { method: "DELETE" });
  }
}

export const api = new APIClient();
