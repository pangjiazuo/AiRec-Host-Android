#include <fcntl.h>
#include <linux/media.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>
// Camera HAL 关闭后会解除媒体连线；恢复采集所需的三条运行时链路。
static bool prepare(const char* path) {
  int fd = open(path, O_RDWR | O_CLOEXEC);
  if (fd < 0) return false;
  std::map<unsigned, std::string> names;
  std::vector<media_entity_desc> entities;
  media_entity_desc entity{};
  entity.id = MEDIA_ENT_ID_FLAG_NEXT;
  while (ioctl(fd, MEDIA_IOC_ENUM_ENTITIES, &entity) == 0) {
    names[entity.id] = entity.name;
    entities.push_back(entity);
    entity.id |= MEDIA_ENT_ID_FLAG_NEXT;
  }
  bool ok = true;
  for (const auto& ent : entities) {
    std::vector<media_pad_desc> pads(ent.pads);
    std::vector<media_link_desc> links(ent.links);
    media_links_enum ls{};
    ls.entity = ent.id;
    ls.pads = pads.data();
    ls.links = links.data();
    if (ioctl(fd, MEDIA_IOC_ENUM_LINKS, &ls)) {
      ok = false;
      break;
    }
    for (auto link : links) {
      if (link.source.entity != ent.id) continue;
      const auto& src = names[link.source.entity];
      const auto& dst = names[link.sink.entity];
      bool wanted = (src.find("m00_") == 0 || src.find("m01_") == 0) &&
                    dst == "rockchip-mipi-dphy-rx";
      wanted |= src == "rockchip-mipi-dphy-rx" && dst == "rkisp1-isp-subdev";
      wanted |= src == "rkisp1-isp-subdev" && dst == "rkisp1_mainpath";
      if (wanted && !(link.flags & MEDIA_LNK_FL_ENABLED)) {
        link.flags |= MEDIA_LNK_FL_ENABLED;
        if (ioctl(fd, MEDIA_IOC_SETUP_LINK, &link)) ok = false;
      }
    }
  }
  close(fd);
  return ok;
}
// 只负责把指定 AHD 设备的已打开描述符交给 APK，不运行录像业务。
int main(int argc, char** argv) {
  if (argc != 3 ||
      (strcmp(argv[2], "/dev/video0") && strcmp(argv[2], "/dev/video5")))
    return 2;
  if (!prepare(strcmp(argv[2], "/dev/video0") == 0 ? "/dev/media0"
                                                   : "/dev/media1")) {
    perror("prepare media");
    return 7;
  }
  int video = open(argv[2], O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (video < 0) {
    perror("open AHD");
    return 3;
  }
  int sock = socket(AF_UNIX, SOCK_STREAM, 0);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (strlen(argv[1]) > 100) return 4;
  strcpy(addr.sun_path + 1, argv[1]);
  if (connect(sock, (sockaddr*)&addr,
              offsetof(sockaddr_un, sun_path) + 1 + strlen(argv[1]))) {
    perror("connect APK");
    return 5;
  }
  char byte = 'V';
  iovec io{&byte, 1};
  char control[CMSG_SPACE(sizeof(int))]{};
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = control;
  msg.msg_controllen = sizeof(control);
  cmsghdr* c = CMSG_FIRSTHDR(&msg);
  c->cmsg_level = SOL_SOCKET;
  c->cmsg_type = SCM_RIGHTS;
  c->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(c), &video, sizeof(int));
  int result = sendmsg(sock, &msg, 0);
  close(video);
  close(sock);
  return result == 1 ? 0 : 6;
}
