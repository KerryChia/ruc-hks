// Only top-level course directory metadata belongs in the public release.
// The downloaded snapshots and file-level inventories stay outside the app tree.
export const probabilityCourseId = '10000000-0000-4000-8000-000000000002';

const ruc = {
  name: '人大试卷归档', repository: 'Inkkdot/ruc-exam-archive', commit: '580dfb8ae4ff8a73585525cc1e70a9dec05c9a9c'
};
const gsai = {
  name: '高瓴课程资料', repository: 'lru0612/GSAI-2th-courses', commit: 'cb704b0d6dac0915eb3049c92fdd4f6e6d9615b9'
};

function entry(source: typeof ruc, key: string, path: string, title: string, count: number, existingCourseId?: string) {
  const url = `https://github.com/${source.repository}/tree/${source.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const ordinal = (key.startsWith('RUC') ? 100 : 200) + Number(key.slice(-2));
  const courseId = existingCourseId ?? `30000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  return { key, title, sourceName: source.name, url, count, courseId, referenceExistingCourse: Boolean(existingCourseId) };
}

export const courseSourceIndex = [
  entry(ruc, 'RUC-01', 'files/ACM-ICPC算法分析与设计', '算法分析与设计（ACM-ICPC）', 1),
  entry(ruc, 'RUC-02', 'files/Fa-数据思维', '数据思维（Fa）', 2),
  entry(ruc, 'RUC-03', 'files/JAVA程序设计', '程序设计（Java）', 1),
  entry(ruc, 'RUC-04', 'files/java课程', '程序设计（Java课程）', 1),
  entry(ruc, 'RUC-05', 'files/人工智能与Python程序设计', '人工智能与Python程序设计', 3),
  entry(ruc, 'RUC-06', 'files/数据库系统概论', '数据库系统概论', 9),
  entry(ruc, 'RUC-07', 'files/数据结构与算法I', '数据结构与算法I', 26),
  entry(ruc, 'RUC-08', 'files/数据结构与算法荣誉课程I', '数据结构与算法荣誉课程I', 2),
  entry(ruc, 'RUC-09', 'files/机器学习基础（荣誉课程）', '机器学习基础（荣誉课程）', 1),
  entry(ruc, 'RUC-10', 'files/程序设计II', '程序设计II', 1),
  entry(ruc, 'RUC-11', 'files/程序设计实践', '程序设计实践', 1),
  entry(ruc, 'RUC-12', 'files/程设1', '程序设计I', 3),
  entry(ruc, 'RUC-13', 'files/算法分析与设计', '算法分析与设计', 3),
  entry(ruc, 'RUC-14', 'files/编译原理', '编译原理', 4),
  entry(ruc, 'RUC-15', 'files/运筹学基础', '运筹学基础', 1),
  entry(ruc, 'RUC-16', 'files/高级程序设计II', '高级程序设计II', 1),
  entry(gsai, 'GSAI-01', 'First_sem/AI  Intro', '人工智能导论', 2),
  entry(gsai, 'GSAI-02', 'First_sem/Data structure and algorithm', '数据结构与算法（高瓴）', 16),
  entry(gsai, 'GSAI-03', 'First_sem/ICS', '计算机系统导论I', 7),
  entry(gsai, 'GSAI-04', 'First_sem/Math Basis', '人工智能数学基础', 4),
  entry(gsai, 'GSAI-05', 'First_sem/Probability and Statistics', '概率论与数理统计', 14, probabilityCourseId),
  entry(gsai, 'GSAI-06', 'Second_sem/Algorithm', '算法分析与设计（高瓴）', 20),
  entry(gsai, 'GSAI-07', 'Second_sem/ICS2', '计算机系统导论II', 6),
  entry(gsai, 'GSAI-08', 'Second_sem/ML', '机器学习基础（高瓴）', 8),
  entry(gsai, 'GSAI-09', 'Second_sem/Optimization', '最优化方法（高瓴）', 1)
];
