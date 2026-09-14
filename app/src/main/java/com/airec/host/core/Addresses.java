package com.airec.host.core;

import java.net.*;
import java.util.*;

public final class Addresses {
  public static String local() {
    List<String> addresses = new ArrayList<>();
    try {
      Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
      while (interfaces.hasMoreElements()) {
        NetworkInterface net = interfaces.nextElement();
        if (!net.isUp() || net.isLoopback()) continue;
        Enumeration<InetAddress> values = net.getInetAddresses();
        while (values.hasMoreElements()) {
          InetAddress value = values.nextElement();
          if (value instanceof Inet4Address && !value.isLinkLocalAddress())
            addresses.add("http://" + value.getHostAddress() + ":8080");
        }
      }
    } catch (SocketException ignored) {
    }
    return addresses.isEmpty() ? "网络未连接 · 本机仍可录像" : String.join("  ", addresses);
  }
}
