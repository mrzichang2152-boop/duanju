const tokenKey = "shortplay_token";
const emailKey = "shortplay_email";

export const getToken = () =>
  typeof window === "undefined" ? null : localStorage.getItem(tokenKey);

export const setToken = (token: string) => {
  localStorage.setItem(tokenKey, token);
};

export const clearToken = () => {
  localStorage.removeItem(tokenKey);
};

export const setEmail = (email: string) => {
  localStorage.setItem(emailKey, email);
};

export const getEmail = () =>
  typeof window === "undefined" ? null : localStorage.getItem(emailKey);
