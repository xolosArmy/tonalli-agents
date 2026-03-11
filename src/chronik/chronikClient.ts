import axios from "axios";
import { env } from "../config/env";

export const chronikClient = axios.create({
  baseURL: env.CHRONIK_URL,
  timeout: 10000
});
